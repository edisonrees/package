const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let latestFrame = null;

// Serve viewer page
app.get("/", (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
  <title>Pi Camera Stream</title>
</head>
<body style="margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;">
  <img id="stream" style="max-width:100%;max-height:100%;" />
  <script>
    const img = document.getElementById("stream");
    const ws = new WebSocket(location.origin.replace("http", "ws"));

    ws.binaryType = "arraybuffer";

    ws.onmessage = (event) => {
      const blob = new Blob([event.data], { type: "image/jpeg" });
      img.src = URL.createObjectURL(blob);
    };
  </script>
</body>
</html>
  `);
});

// WebSocket relay
wss.on("connection", (ws, req) => {
  const isSender = req.url.includes("sender");

  if (isSender) {
    ws.on("message", (data) => {
      latestFrame = data;

      // broadcast to all viewers
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      });
    });
  } else {
    // viewer gets latest frame on connect
    if (latestFrame) ws.send(latestFrame);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
