# TsTurbo

A high-performance **Node.js** and **TypeScript** web server built from scratch, supporting **HTTP Range Requests**, **Chunked Transfer Encoding**, and efficient file streaming. This project demonstrates deep knowledge of HTTP protocols and custom server design.

## Features

- **Custom HTTP Server**: Built from scratch with Node.js and TypeScript, handling HTTP requests and responses without external libraries.
- **HTTP Range Requests**: Supports range requests for partial content delivery, ideal for media streaming or large file downloads.
- **Chunked Transfer Encoding**: Enables efficient streaming of large payloads with chunked transfer encoding.
- **Optimized File Handling**: Uses non-blocking file I/O for high-performance streaming.
- **Low-Level Control**: Implements custom TCP socket handling, request parsing, header validation, and error management.

## Technologies Used

- **Node.js**: For handling HTTP requests, responses, and file I/O.
- **TypeScript**: Adds type safety and better code structure to the project.
- **TCP Sockets**: Low-level socket programming to manage connections.
- **HTTP/1.1**: Protocol-level understanding of HTTP request/response lifecycle.

## Installation

1. Clone the repository:
```bash
git clone https://github.com/SattuSupari21/tsturbo.git
```
2. Install dependencies:
```
npm install
```
3. Run the server:
```
npm start
```
The server will start running on `http://127.0.0.1:1234`.

## Paths

- `/`: Root path, serves a simple "hello world" message.
- `/echo/`: Echoes back the request body.
- `/files/{filename}`: Serves files from the server's filesystem. Supports **HTTP Range Requests** for partial file delivery.
- `/welcome`: Displays a welcome page.

## Usage

- GET Request: You can test the server by sending a GET request to the server's root or any other file path (e.g., /files/{filename}).
Example:
```
curl http://127.0.0.1:1234/files/testfile.txt
```
- POST Request: Send a simple POST request with body or to test chunked transfer encoding, send a POST request with Transfer-Encoding: chunked.

Example:
```
curl -X POST http://127.0.0.1:1234/echo/ \
     -H "Transfer-Encoding: chunked" \
     --data-binary @- <<EOF
5
Hello
6
World!
0
EOF
```
