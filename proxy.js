
/**
 * Module dependencies.
 */

var net = require('net');
var url = require('url');
var http = require('http');
var assert = require('assert');
var debug = require('debug')('proxy');

/**
 * Module exports.
 */

module.exports = setup;

/**
 * Sets up an `http.Server` or `https.Server` instance with the necessary
 * "request" and "connect" event listeners in order to make the server act as an
 * HTTP proxy.
 *
 * @param {http.Server|https.Server} server
 * @param {Object} options
 * @api public
 */

function setup (server, options) {
  if (!server) http.createServer();
  server.on('request', onrequest);
  server.on('connect', onconnect);
  return server;
}

/**
 * 13.5.1 End-to-end and Hop-by-hop Headers
 *
 * Hop-by-hop headers must be removed by the proxy before passing it on to the
 * next endpoint. Per-request basis hop-by-hop headers MUST be listed in a
 * Connection header, (section 14.10) to be introduced into HTTP/1.1 (or later).
 */

var hopByHopHeaders = [
  'Connection',
  'Keep-Alive',
  'Proxy-Authenticate',
  'Proxy-Authorization',
  'TE',
  'Trailers',
  'Transfer-Encoding',
  'Upgrade'
];

/**
 * Iterator function for the request/response's "headers".
 * Invokes `fn` for "each" header entry in the request.
 *
 * @api private
 */

function eachHeader (obj, fn) {
}

/**
 * HTTP GET/POST/DELETE/PUT, etc. proxy requests.
 */

function onrequest (req, res) {
  debug('← ← ← %s %s HTTP/%s ', req.method, req.url, req.httpVersion);
  var server = this;
  var socket = req.socket;

  // pause the socket during authentication so no data is lost
  socket.pause();

  authenticate(server, req, function (err, auth) {
    socket.resume();
    if (err) {
      // an error occured during login!
      res.writeHead(500);
      res.end((err.stack || err.message || err) + '\n');
      return;
    }
    if (!auth) return requestAuthorization(req, res);;
    var parsed = url.parse(req.url);
    if ('http:' != parsed.protocol) {
      // only "http://" is supported, "https://" should use CONNECT method
      res.writeHead(400);
      res.end('Only "http:" protocol prefix is supported\n');
      return;
    }

    parsed.method = req.method;
    // TODO: remove hop-by-hop headers
    parsed.headers = req.headers;

    // custom `http.Agent` support, set `server.agent`
    var agent = server.agent;
    if (null != agent) {
      debug('↑ ↑ ↑ setting custom `http.Agent` option for proxy request: %s', agent);
      parsed.agent = agent;
      agent = null;
    }

    var proxyReq = http.request(parsed);
    debug('↑ ↑ ↑ %s %s HTTP/1.1 ', proxyReq.method, proxyReq.path);

    proxyReq.on('response', function (proxyRes) {
      debug('↓ ↓ ↓ HTTP/1.1 %s', proxyRes.statusCode);
      debug('→ → → HTTP/1.1 %s', proxyRes.statusCode);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', function (err) {
      debug('↓ ↓ ↓ proxy HTTP request "error" event %j', err.stack || err);
      console.error('proxyReq "error" event', err);
      // TODO: respond to `res`
    });

    // if the client closes the connection prematurely,
    // then close the upstream socket
    req.socket.on('close', function () {
      debug('← ← ← client socket "close" event');
      proxyReq.abort();
    });

    req.pipe(proxyReq);
  });
}

/**
 * HTTP CONNECT proxy requests.
 */

function onconnect (req, socket, head) {
  debug('← ← ← %s %s HTTP/%s ', req.method, req.url, req.httpVersion);
  assert(!head || 0 == head.length, '"head" should be empty for proxy requests');

  // create the `res` instance for this request since Node.js
  // doesn't provide us with one :(
  // XXX: this is undocumented API, so it will break some day (ノಠ益ಠ)ノ彡┻━┻
  var res = new http.ServerResponse(req);
  res.shouldKeepAlive = false;
  res.chunkedEncoding = false;
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);

  // pause the socket during authentication so no data is lost
  socket.pause();

  authenticate(this, req, function (err, auth) {
    socket.resume();
    if (err) {
      // an error occured during login!
      res.writeHead(500);
      res.end((err.stack || err.message || err) + '\n');
      return;
    }
    if (!auth) return requestAuthorization(req, res);;

    var parts = req.url.split(':');
    var host = parts[0];
    var port = +parts[1];
    var opts = { host: host, port: port };

    debug('↑ ↑ ↑ connecting to proxy target %s', req.url);
    var destination = net.connect(opts);

    destination.on('connect', function () {
      debug('↓ ↓ ↓ proxy target %s "connect" event', req.url);
      debug('→ → → HTTP/1.1 200 Connection established');
      var headers = {
      };
      res.writeHead(200, 'Connection established', headers);

      // HACK: force a flush of the HTTP header
      res._send('');

      // relinquish control of the `socket` from the ServerResponse instance
      res.detachSocket(socket);

      socket.pipe(destination);
      destination.pipe(socket);
    });
    destination.on('close', function () {
      debug('↓ ↓ ↓ proxy target %s "close" event', req.url);
      socket.destroy();
    });
    destination.on('error', function (e) {
      debug('↓ ↓ ↓ proxy target %s "error" event: %s', req.url, e.stack || e);
      requestAuthorization(req, res);
    });
  });
}

/**
 * Checks `Proxy-Authorization` request headers. Same logic applied to CONNECT
 * requests as well as regular HTTP requests.
 *
 * @param {http.Server} server
 * @param {http.ServerRequest} req
 * @param {Function} fn callback function
 * @api private
 */

function authenticate (server, req, fn) {
  if ('function' == typeof server.authenticate) {
    debug('authenticating request "%s %s"', req.method, req.url);
    server.authenticate(req, fn);
  } else {
    // no `server.authenticate()` function, so just allow the request
    fn(null, true);
  }
}

/**
 * Sends a "407 Proxy Authentication Required" HTTP response to the `socket`.
 *
 * @api private
 */

function requestAuthorization (req, res) {
  // request Basic proxy authorization
  debug('requesting proxy authorization for "%s %s"', req.method, req.url);

  // TODO: make "realm" and "type" (Basic) be configurable...
  var realm = 'proxy';

  var headers = {
    'Proxy-Authenticate': 'Basic realm="' + realm + '"'
  };
  res.writeHead(407, headers);
  res.end();
}
