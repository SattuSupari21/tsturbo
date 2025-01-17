import * as net from "net";
import * as fs from "fs/promises";

type TCPConn = {
  socket: net.Socket;
  err: null | Error;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

type DynBuf = {
  data: Buffer;
  length: number;
};

// an interface for reading/writing data from/to the HTTP body.
type BodyReader = {
  // the "Content-Length", -1 if unknown
  length: number;
  // read data, returns an empty buffer after EOF.
  read: () => Promise<Buffer>;
  close?: () => Promise<void>;
};

// a parsed HTTP request header
type HTTPReq = {
  method: string;
  uri: Buffer;
  version: string;
  headers: Buffer[];
};

// an HTTP response
type HTTPRes = {
  code: number;
  headers: Buffer[];
  body: BodyReader;
};

class HTTPError extends Error {
  code: number;
  message: string;
  constructor(code: number, message: string) {
    super();
    this.code = code;
    this.message = message;
  }
}

interface FileReadResult {
  bytesRead: number;
  buffer: Buffer;
}

interface FileReadOptions {
  buffer?: Buffer;
  offset?: number | null;
  length?: number | null;
  position?: number | null;
}

interface Stats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
}

interface FileHandle {
  read(options?: FileReadOptions): Promise<FileReadResult>;
  close(): Promise<void>;
  stat(): Promise<Stats>;
}

function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = {
    socket: socket,
    err: null,
    ended: false,
    reader: null,
  };
  socket.on("data", (data: Buffer) => {
    console.assert(conn.reader);
    conn.socket.pause();
    conn.reader!.resolve(data);
    conn.reader = null;
  });
  socket.on("end", () => {
    conn.ended = true;
    if (conn.reader) {
      conn.reader.resolve(Buffer.from("")); // eof
      conn.reader = null;
    }
  });
  socket.on("error", (err: Error) => {
    conn.err = err;
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });
  return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
  console.assert(!conn.reader);
  return new Promise((resolve, reject) => {
    if (conn.err) {
      reject(conn.err);
      return;
    }
    if (conn.ended) {
      resolve(Buffer.from("")); //  eof
      return;
    }

    conn.reader = { resolve: resolve, reject: reject };
    conn.socket.resume();
  });
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
  console.assert(data.length > 0);
  return new Promise((resolve, reject) => {
    if (conn.err) {
      reject(conn.err);
      return;
    }

    conn.socket.write(data, (err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// append data to DynBuf
function bufPush(buf: DynBuf, data: Buffer): void {
  const newLen = buf.length + data.length;
  if (buf.data.length < newLen) {
    // grow the capacity by the power of two
    let cap = Math.max(buf.data.length, 32);
    while (cap < newLen) {
      cap *= 2;
    }
    const grown = Buffer.alloc(cap);
    buf.data.copy(grown, 0, 0);
    buf.data = grown;
  }
  data.copy(buf.data, buf.length, 0);
  buf.length = newLen;
}

function bufPop(buf: DynBuf, len: number): void {
  buf.data.copyWithin(0, len, buf.length);
  buf.length -= len;
}

function splitLines(data: Buffer): Buffer[] {
  const dataString = data.toString();
  const lines = dataString.split("\r\n");

  let bufArray: Buffer[] = [];
  for (let i = 0; i < lines.length; i++) {
    bufArray.push(Buffer.from(lines[i]));
  }
  return bufArray;
}

function parseRequestLine(line: Buffer) {
  const lineString = line.toString().split(" ");
  const method: string = lineString[0];
  const uri: string = lineString[1];
  const version: string = lineString[2];
  return [method, uri, version];
}

function validateHeader(h: Buffer) {
  const validHeaderRegex = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;
  const possibleHeaders = [
    "Accept",
    "Accept-Charset",
    "Accept-Encoding",
    "Accept-Language",
    "Authorization",
    "Cache-Control",
    "Connection",
    "Content-Length",
    "Content-Type",
    "Cookie",
    "Date",
    "Expect",
    "Host",
    "Referer",
    "User-Agent",
    "If-Match",
    "If-None-Match",
    "If-Modified-Since",
    "If-Unmodified-Since",
    "Range",
    "Origin",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade-Insecure-Requests",
    "",
  ];
  const header = h.toString().split(":")[0]; // get the key(header name) from key:value header format
  if (possibleHeaders.includes(header) || validHeaderRegex.test(header)) {
    return true;
  } else {
    return false;
  }
}

// parse the HTTP request header
function parseHTTPReq(data: Buffer): HTTPReq {
  // split the data into lines
  const lines: Buffer[] = splitLines(data);
  // the first line is `METHOD URI VERSION`
  const [method, uri, version] = parseRequestLine(lines[0]);
  // followed by header fields in the format of `Name: Value`
  const headers: Buffer[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const h = Buffer.from(lines[i]); // copy
    if (!validateHeader(h)) {
      throw new HTTPError(400, "bad field");
    }
    headers.push(h);
  }
  // the header ends by an empty line
  console.assert(lines[lines.length - 1].length === 0);
  return {
    method: method,
    uri: Buffer.from(uri),
    version: version,
    headers: headers,
  };
}

// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// parse & remove a header from the beginning of the buffer if possible
function cutMessage(buf: DynBuf): null | HTTPReq {
  // the end of the header is marked by '\r\n\r\n'
  const idx = buf.data.subarray(0, buf.length).indexOf("\r\n\r\n");
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen) {
      throw new HTTPError(413, "header is too large");
    }
    return null; // not complete, need more data
  }
  // parse & remove the header
  const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

function fieldGet(headers: Buffer[], key: string): null | Buffer {
  const headersString = headers.toString();
  if (headersString.includes(key)) {
    const pos_one = headersString.indexOf(key); // get the position of field name
    const pos_two = headersString.indexOf("\r\n", pos_one); // get the position of field value
    let field = headersString.slice(pos_one, pos_two); // extract key value pair
    field = field.split(":")[1].trim(); // [field_name, field_value]

    // check for Transfer-Encoding
    if (key === "Transfer-Encoding") {
      field = field.split(",")[0].trim();
    }

    return Buffer.from(field); //  convert to buffer and return
  } else {
    return null;
  }
}

function parseDec(contentLen: string) {
  return parseFloat(contentLen);
}

function readerFromConnLength(
  conn: TCPConn,
  buf: DynBuf,
  remain: number,
): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> => {
      if (remain === 0) {
        return Buffer.from(""); // done
      }
      if (buf.length === 0) {
        // try to get some data if there is none
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0) {
          // expect more data!
          throw new Error("Unexpected EOF from HTTP body");
        }
      }
      // consume data from the buffer
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return data;
    },
  };
}

async function bufExpectMore(conn: TCPConn, buf: DynBuf): Promise<void> {
  try {
    const data = await soRead(conn);
    bufPush(buf, data);
  } catch (error) {
    throw new Error("Failed to read more data.");
  }
}

// decode the chunked encoding and yield the data on the fly
async function* readChunks(conn: TCPConn, buf: DynBuf): BufferGenerator {
  for (let last = false; !last;) {
    // read the chunk-size line
    const idx = buf.data.subarray(0, buf.length).indexOf("\r\n");
    if (idx < 0) {
      await bufExpectMore(conn, buf);
      continue;
    }
    // parse the chunk-size and remove the line
    let remain = parseInt(buf.data.subarray(0, idx).toString(), 16);
    bufPop(buf, idx + 2);
    // is it the last one?
    last = remain === 0;
    // read and yield the chunk data
    while (remain > 0) {
      if (buf.length === 0) {
        await bufExpectMore(conn, buf);
      }

      const consume = Math.min(remain, buf.length);
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      remain -= consume;
      yield data;
    }
    // the chunk data is followed by CRLF
    if (buf.length < 2) {
      await bufExpectMore(conn, buf);
    }
    bufPop(buf, 2); //  remove CRLF
  }
}

// BodyReader from an HTTP request
function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
  let bodyLen = -1;
  const contentLen = fieldGet(req.headers, "Content-Length");
  if (contentLen) {
    bodyLen = parseDec(contentLen.toString("latin1"));
    if (isNaN(bodyLen)) {
      throw new HTTPError(400, "bad Content-Length.");
    }
  }
  const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");
  const chunked =
    fieldGet(req.headers, "Transfer-Encoding")?.equals(
      Buffer.from("chunked"),
    ) || false;
  if (!bodyAllowed && (bodyLen > 0 || chunked)) {
    throw new HTTPError(400, "HTTP body not allowed");
  }
  if (!bodyAllowed) {
    bodyLen = 0;
  }

  if (bodyLen >= 0) {
    // "Content-Length" is present
    return readerFromConnLength(conn, buf, bodyLen);
  } else if (chunked) {
    // chunked encoding
    return readerFromGenerator(readChunks(conn, buf));
  } else {
    // read the rest of the connection
    return readerFromConnEOF(conn, buf);
    throw new HTTPError(501, "TODO");
  }
}

// BodyReader from in-memory data
function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async (): Promise<Buffer> => {
      if (done) {
        return Buffer.from(""); // no more data
      } else {
        done = true;
        return data;
      }
    },
  };
}

type BufferGenerator = AsyncGenerator<Buffer, void, void>;

// count to 99
async function* countSheep(): BufferGenerator {
  for (let i = 0; i < 100; i++) {
    // sheep 1s, then output the counter
    await new Promise((resolve) => setTimeout(resolve, 1000));
    yield Buffer.from(`${i}\n`);
  }
}

function readerFromGenerator(gen: BufferGenerator): BodyReader {
  return {
    length: -1,
    read: async (): Promise<Buffer> => {
      const r = await gen.next();
      if (r.done) {
        return Buffer.from(""); // EOF
      } else {
        // @ts-ignore
        console.assert(r.value!.length > 0);
        // @ts-ignore
        return r.value;
      }
    },
  };
}

// reads data from a TCP connection until EOF
function readerFromConnEOF(conn: TCPConn, buf: DynBuf): BodyReader {
  return {
    length: -1,
    read: async (): Promise<Buffer> => {
      // check if buffer has any data left
      if (buf.length > 0) {
        const data = Buffer.from(buf.data.subarray(0, buf.length));
        bufPop(buf, buf.length);
        return data;
      }

      // wait for new data from the connection
      const data = await soRead(conn);
      if (data.length === 0) {
        // connection closed
        return Buffer.from(""); //   EOF
      }

      // append new data to the buffer
      bufPush(buf, data);

      // return the new data
      const result = Buffer.from(buf.data.subarray(0, buf.length));
      bufPop(buf, buf.length);
      return result;
    },
  };
}

function readerFromStaticFile(fp: fs.FileHandle, size: number): BodyReader {
  let got = 0; // bytes read so far
  return {
    length: size,
    read: async (): Promise<Buffer> => {
      const r: fs.FileReadResult<Buffer> = await fp.read();
      got += r.bytesRead;
      if (got > size || (got < size && r.bytesRead === 0)) {
        // unhappy case: file size changed.
        // cannot continue since we have sent the 'Content-Length'
        throw new Error("file size changed, abandon it!");
      }
      // NOTE: the automatically allocated buffer may be larger
      return r.buffer.subarray(0, r.bytesRead);
    },
    close: async () => await fp.close(),
  };
}

// read from [start, end]
function readerFromStaticFileRange(
  fp: fs.FileHandle,
  start: number,
  end: number,
): BodyReader {
  let offset = start;
  let buf: Buffer | null = Buffer.alloc(8192);
  return {
    length: end - start,
    read: async (): Promise<Buffer> => {
      if (offset >= end) {
        if (buf !== null) {
          buf = null;
        }
        return Buffer.from(""); //   return EOF when all data has been read
      }

      // reinitialize buffer if cleared earlier
      if (!buf) {
        buf = Buffer.alloc(50);
      }
      const maxread = Math.min(buf.length, end - offset); // may be 0
      const r: fs.FileReadResult<Buffer> = await fp.read({
        buffer: buf,
        position: offset,
        length: maxread,
      });
      offset += r.bytesRead;
      return buf.subarray(0, r.bytesRead);
    },
    close: async () => {
      if (buf !== null) {
        buf = null;
      }
      await fp.close();
    },
  };
}

function resp404(): HTTPRes {
  return {
    code: 404,
    headers: [],
    body: readerFromMemory(Buffer.from("404 Not Found\n")),
  };
}

async function staticFileResp(
  req: HTTPReq,
  fp: fs.FileHandle,
  size: number,
): Promise<HTTPRes> {
  const rangeHeader = fieldGet(req.headers, "Range");

  // no 'Range' header, send entire file
  if (!rangeHeader) {
    const reader: BodyReader = readerFromStaticFile(fp, size);
    return {
      code: 200,
      headers: [],
      body: reader,
    };
  }

  const [start, end] = parseBytesRanges(rangeHeader, size);
  if (start === null || start >= size) {
    return {
      code: 416, // Range Not Satisfiable
      headers: [Buffer.from(`Content-Range: bytes */${size}`)],
      body: readerFromStaticFile(fp, 0),
    };
  }

  const reader: BodyReader = readerFromStaticFileRange(fp, start!, end!);
  return {
    code: 206,
    headers: [Buffer.from(`Content-Range: bytes ${start}-${end}/${size}`)],
    body: reader,
  };
}

async function serveStaticFile(req: HTTPReq, path: string): Promise<HTTPRes> {
  let fp: null | fs.FileHandle = null;
  try {
    // open the file
    fp = await fs.open(path, "r");
    // get the size
    const stat = await fs.stat(path);
    if (!stat.isFile()) {
      return resp404(); //   not a regular file?
    }
    const size = stat.size;
    // the body reader
    return staticFileResp(req, fp, size);
  } catch (exc) {
    // cannot open the file or whatever
    console.info("error serving file.", exc);
    return resp404();
  }
}

function parseBytesRanges(
  rangeHeader: Buffer,
  size: number,
): [number | null, number | null] {
  const match = rangeHeader.toString().match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    return [null, null];
  }
  const start = match[1] ? parseInt(match[1]) : 0;
  const end = match[2] ? parseInt(match[2]) : size;
  return [start, end];
}

// a sample request handler
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
  // act on the request URI
  let resp: BodyReader;
  const uri = req.uri.toString("utf8");
  if (uri === "/echo") {
    // http echo server
    resp = body;
  } else if (uri === "/sheep") {
    resp = readerFromGenerator(countSheep());
  } else if (uri.startsWith("/files/")) {
    // serve files from the current working directory
    // FIXME: prevent escaping by ".."
    return await serveStaticFile(req, uri.substr("/files/".length));
  } else if (uri === "/welcome") {
    return await serveStaticFile(req, "welcome.html")
  } else {
    resp = readerFromMemory(Buffer.from("hello world.\n"));
  }

  return {
    code: 200,
    headers: [Buffer.from("Server: my_first_http_server")],
    body: resp,
  };
}

// function to get appropriate HTTP status messages
function getHttpStatusMessage(statusCode: number): string {
  switch (statusCode) {
    case 200:
      return "200 OK";
    case 201:
      return "201 Created";
    case 204:
      return "204 No Content";
    case 206:
      return "206 Partial Content";
    case 400:
      return "400 Bad Request";
    case 401:
      return "401 Unauthorized";
    case 403:
      return "403 Forbidden";
    case 404:
      return "404 Not Found";
    case 500:
      return "500 Internal Server Error";
    case 502:
      return "502 Bad Gateway";
    case 503:
      return "503 Service Unavailable";
    default:
      return `${statusCode} Unknown Status Code`;
  }
}

function encodeHTTPResp(resp: HTTPRes): Buffer {
  const status = getHttpStatusMessage(resp.code);
  let response = `HTTP/1.1 ${status}\r\n`;
  const headersArray = resp.headers.toString().split(",");
  for (let i = 0; i < headersArray.length; i++) {
    response += headersArray[i] + "\r\n";
  }
  response += "\r\n";
  return Buffer.from(response);
}

async function writeHTTPHeader(conn: TCPConn, resp: HTTPRes): Promise<void> {
  // set the "Content-Length" or "Transfer-Encoding" field
  if (resp.body.length < 0) {
    resp.headers.push(Buffer.from("Transfer-Encoding: chunked"));
  } else {
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
  }
  // write the header
  await soWrite(conn, encodeHTTPResp(resp));
}

async function writeHTTPBody(conn: TCPConn, resp: HTTPRes): Promise<void> {
  // write the body
  const crlf = Buffer.from("\r\n");
  for (let last = false; !last;) {
    let data = await resp.body.read();
    last = data.length === 0; //  ended?
    if (resp.body.length < 0) {
      //  chunked encoding
      data = Buffer.concat([
        Buffer.from(data.length.toString(16)),
        crlf,
        data,
        crlf,
      ]);
    }
    if (data.length) {
      await soWrite(conn, data);
    }
  }
}

async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };

  while (true) {
    // try to get 1 message from the Buffer
    const msg: null | HTTPReq = cutMessage(buf);
    if (!msg) {
      // need more data
      const data = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length === 0 && buf.length === 0) {
        return; // no more requests
      }
      if (data.length === 0) {
        throw new HTTPError(400, "Unexpected EOF.");
      }
      continue;
    }

    // process the message and send the response
    const reqBody: BodyReader = readerFromReq(conn, buf, msg);
    const res: HTTPRes = await handleReq(msg, reqBody);
    try {
      await writeHTTPHeader(conn, res);
      if (msg.method !== "HEAD") {
        await writeHTTPBody(conn, res);
      }
    } finally {
      await res.body.close?.(); //  cleanups
    }
    // close the connection for HTTP/1.0
    if (msg.version === "1.0") {
      return;
    }
    //make sure that the request body is consumed completely
    while ((await reqBody.read()).length > 0) {
      /* empty */
    }
  } // loop for messages
}

async function newConn(socket: net.Socket): Promise<void> {
  const conn: TCPConn = soInit(socket);
  try {
    await serveClient(conn);
  } catch (exc) {
    console.log("exception:", exc);
    if (exc instanceof HTTPError) {
      // intended to send an error response
      const resp: HTTPRes = {
        code: exc.code,
        headers: [],
        body: readerFromMemory(Buffer.from(exc.message + "\n")),
      };
    }
  } finally {
    socket.destroy();
  }
}

let server = net.createServer({ pauseOnConnect: true });

server.on("error", (err: Error) => {
  throw err;
});
server.on("connection", newConn);

server.listen({ host: "127.0.0.1", port: 1234 }, () => {
  console.log("[SERVER] server started on port 1234");
});
