const WebSocket = require("ws");

// Слушаем все интерфейсы (0.0.0.0)
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT, host: "0.0.0.0" });

let sessions = {};
let players = [];
let disconnectedPlayers = {}; // { [playerId]: { code, timeoutId } }

function generateCode(length = 4) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

const RECONNECT_WAIT_MS = 20000;

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      console.error("Invalid JSON:", message);
      return;
    }

    if (data.type === "connect") {
      ws.playerId = data?.id ?? generateCode(6);

      // Replace old player if reconnecting
      if (data?.id) {
        const idx = players.findIndex((p) => p.playerId === data.id);
        if (idx !== -1) players[idx] = ws;
        else players.push(ws);
      } else {
        players.push(ws);
      }

      console.log(`# Player ${ws.playerId} connected`);
      ws.send(JSON.stringify({ type: "welcome", playerId: ws.playerId }));

      // Restore session if disconnected
      const d = disconnectedPlayers[ws.playerId];
      if (d) {
        clearTimeout(d.timeoutId);
        delete disconnectedPlayers[ws.playerId];
        const session = sessions[d.code];
        if (session) {
          const idx = session.players.findIndex((p) => p.playerId === ws.playerId);
          if (idx !== -1) session.players[idx] = ws;
          else if (session.players.length < 2) session.players.push(ws);
          ws.sessionCode = d.code;
          console.log(`# Player ${ws.playerId} reconnected to Session ${d.code}`);
        }
      }
      return;
    }

    if (data.type === "createSession") {
      const code = generateCode();
      sessions[code] = { players: [ws], code, playersReady: 0 };
      ws.sessionCode = code;
      ws.send(JSON.stringify({ type: "sessionCreated", code }));
      console.log(`# Player ${ws.playerId} created Session ${code}`);
      ws.send(JSON.stringify({ type: "sessionJoined", code }));
      return;
    }

    if (data.type === "joinSession") {
      const code = data.code;
      if (sessions[code] && sessions[code].players.length === 1) {
        sessions[code].players.push(ws);
        ws.sessionCode = code;
        ws.send(JSON.stringify({ type: "sessionJoined", code }));
        console.log(`# Player ${ws.playerId} joined Session ${code}`);
        sessions[code].players.forEach((p, idx) =>
          p.send(JSON.stringify({ type: "sessionReady", player: idx + 1 }))
        );
      } else {
        ws.send(JSON.stringify({ type: "sessionInvalid" }));
        console.log(`# Player ${ws.playerId} tried invalid Session ${code}`);
      }
      return;
    }

    if (data.type === "gameStart" && ws.sessionCode) {
      const session = sessions[ws.sessionCode];
      if (!session.firstPlayer) {
        session.firstPlayer =
          session.players[Math.floor(Math.random() * session.players.length)].playerId;
      }
      console.log("firstPlayer = ", session.firstPlayer);
      session.players.forEach((p) =>
        p.send(JSON.stringify({ type: "coinToss", player: session.firstPlayer }))
      );
      return;
    }

    if (data.type === "initial_reDraw" && ws.sessionCode) {
      const session = sessions[ws.sessionCode];
      session.playersReady += 1;
      if (session.playersReady === 2) {
        session.players.forEach((p) => p.send(JSON.stringify({ type: "start" })));
        session.playersReady = 0;
      }
      return;
    }

    // Relay messages
    if (ws.sessionCode) {
      const others = sessions[ws.sessionCode]?.players || [];
      others.forEach((p) => {
        if (p !== ws && p.readyState === WebSocket.OPEN) p.send(JSON.stringify(data));
      });
    }
  });

  ws.on("close", () => {
    if (!ws.playerId) return;
    console.log(`# Player ${ws.playerId} disconnected`);

    if (ws.sessionCode && sessions[ws.sessionCode]) {
      const session = sessions[ws.sessionCode];
      const timeoutId = setTimeout(() => {
        if (disconnectedPlayers[ws.playerId] && sessions[ws.sessionCode]) {
          const sess = sessions[ws.sessionCode];
          const other = sess.players.find((p) => p.playerId !== ws.playerId);
          if (other && other.readyState === WebSocket.OPEN)
            other.send(JSON.stringify({ type: "sessionDeleted" }));
          console.log(`# Session ${ws.sessionCode} deleted due to no reconnection`);
          Object.keys(disconnectedPlayers).forEach((pid) => {
            if (disconnectedPlayers[pid].code === ws.sessionCode) {
              clearTimeout(disconnectedPlayers[pid].timeoutId);
              delete disconnectedPlayers[pid];
            }
          });
          delete sessions[ws.sessionCode];
        }
      }, RECONNECT_WAIT_MS);

      disconnectedPlayers[ws.playerId] = { code: ws.sessionCode, timeoutId };

      const other = session.players.find((p) => p !== ws);
      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "opponentDisconnected", playerId: ws.playerId }));
        other.send(JSON.stringify({ type: "sessionUnready" }));
      }

      console.log(`# Player ${ws.playerId} disconnected from Session ${ws.sessionCode}, waiting for reconnection...`);
    }

    players = players.filter((p) => p !== ws);
  });
});

console.log(`## Server is up and running on port ${PORT} ##`);
