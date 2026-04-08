const { io } = require("socket.io-client");

const socket = io("http://api.kekeride.ng", {
    transports: ["websocket"],
    reconnection: false
});

console.log("Attempting socket connection to api.kekeride.ng...");

socket.on("connect", () => {
    console.log("PASS: Socket connected successfully");
    socket.emit("join", { userId: "audit_tester", role: "admin" });
    console.log("ACTION: Sent join event");
    
    // Success: disconnect and exit
    socket.disconnect();
    process.exit(0);
});

socket.on("connect_error", (err) => {
    console.log("FAIL: Socket connection error: " + err.message);
    process.exit(1);
});

setTimeout(() => {
    console.log("FAIL: Socket connection timed out (10s)");
    process.exit(1);
}, 10000);
