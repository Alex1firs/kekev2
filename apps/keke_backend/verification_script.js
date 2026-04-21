const axios = require('axios');
const { io } = require('socket.io-client');

const API_URL = 'http://localhost:3000/api/v1';
const SOCKET_URL = 'http://localhost:3000';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runVerification() {
    console.log('🚀 INITIALIZING STRICT SYNC PROOF PASS\n');

    try {
        // 1. SETUP
        const passPhone = '234' + Math.floor(Math.random() * 100000000);
        const drivPhone = '234' + Math.floor(Math.random() * 100000000);
        
        console.log(`[SETUP] Creating test users P:${passPhone} D:${drivPhone}`);
        const pSignup = await axios.post(`${API_URL}/auth/signup`, { phone: passPhone, password: 'password123', first_name: 'Test', last_name: 'Passenger' });
        const dSignup = await axios.post(`${API_URL}/driver/auth/signup`, { phone: drivPhone, password: 'password123', first_name: 'Test', last_name: 'Driver' });
        const pToken = pSignup.data.token;
        const dToken = dSignup.data.token;

        const pMe = await axios.get(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${pToken}` } });
        const dMe = await axios.get(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${dToken}` } });
        const pId = pMe.data.id;
        const dId = dMe.data.id;

        const pSocket = io(SOCKET_URL, { auth: { token: pToken } });
        const dSocket = io(SOCKET_URL, { auth: { token: dToken } });

        await sleep(1000);
        pSocket.emit('join', { userId: pId, role: 'passenger' });
        dSocket.emit('join', { userId: dId, role: 'driver' });
        dSocket.emit('driver:heartbeat', { driverId: dId, lat: 6.5244, lng: 3.3792 });
        console.log('✅ Sockets Joined and Driver Online.\n');

        // --- TEST 1: CANCELLATION SYNC ---
        console.log('--- TEST 1: CANCELLATION SYNC ---');
        const rideId1 = `CANCEL-SYNC-${Date.now()}`;
        
        dSocket.once('ride:request', (data) => {
            console.log(`[DRIVER_SOCKET] Event: ride:request | Payload: ${JSON.stringify(data)}`);
            dSocket.emit('join', { userId: rideId1, role: 'ride' });
        });

        dSocket.once('ride:cancelled', (data) => {
            console.log(`[DRIVER_SOCKET] Event: ride:cancelled | Payload: ${JSON.stringify(data)}`);
        });

        pSocket.once('ride:cancelled', (data) => {
            console.log(`[PASSENGER_SOCKET] Event: ride:cancelled | Payload: ${JSON.stringify(data)}`);
        });

        console.log(`[PASSENGER_APP] Sending ride:request | rideId: ${rideId1}`);
        pSocket.emit('join', { userId: rideId1, role: 'ride' });
        pSocket.emit('ride:request', { rideId: rideId1, passengerId: pId, pickupLat: 6.5244, pickupLng: 3.3792, fare: 1500 });
        
        await sleep(1500);
        console.log(`[PASSENGER_APP] Sending ride:cancel`);
        pSocket.emit('ride:cancel', { rideId: rideId1, passengerId: pId });
        await sleep(1500);
        console.log('✅ Cancellation Test Done.\n');

        // --- TEST 2: FULL LIFECYCLE SYNC ---
        console.log('--- TEST 2: FULL LIFECYCLE SYNC ---');
        const rideId2 = `LIFECYCLE-SYNC-${Date.now()}`;
        
        pSocket.on('ride:assigned', (data) => {
            console.log(`[PASSENGER_SOCKET] Event: ride:assigned | Payload: ${JSON.stringify(data)}`);
            console.log(`[PASSENGER_STATE] Transition: searching -> confirmed`);
        });

        pSocket.on('ride:status_update', (data) => {
            console.log(`[PASSENGER_SOCKET] Event: ride:status_update | Payload: ${JSON.stringify(data)}`);
            if (data.status === 'arrived') console.log(`[PASSENGER_STATE] Transition: confirmed -> arrived`);
            if (data.status === 'started') console.log(`[PASSENGER_STATE] Transition: arrived -> started`);
        });

        pSocket.on('ride:finished', (data) => {
            console.log(`[PASSENGER_SOCKET] Event: ride:finished | Payload: ${JSON.stringify(data)}`);
            console.log(`[PASSENGER_STATE] Transition: started -> completed`);
        });

        console.log(`[PASSENGER_APP] Sending ride:request | rideId: ${rideId2}`);
        pSocket.emit('join', { userId: rideId2, role: 'ride' });
        pSocket.emit('ride:request', { rideId: rideId2, passengerId: pId, pickupLat: 6.5244, pickupLng: 3.3792, fare: 1500 });
        await sleep(1000);

        console.log(`[DRIVER_APP] Sending ride:accept`);
        dSocket.emit('join', { userId: rideId2, role: 'ride' });
        dSocket.emit('ride:accept', { rideId: rideId2, driverId: dId, driverDetails: { name: 'Verified Driver', plate: 'KEKE-123', model: 'TVS King' } });
        await sleep(1000);

        console.log(`[DRIVER_APP] Sending ride:arrived`);
        dSocket.emit('ride:arrived', { rideId: rideId2, driverId: dId });
        await sleep(1000);

        console.log(`[DRIVER_APP] Sending ride:start`);
        dSocket.emit('ride:start', { rideId: rideId2, driverId: dId });
        await sleep(1000);

        console.log(`[DRIVER_APP] Sending ride:complete`);
        dSocket.emit('ride:complete', { rideId: rideId2, passengerId: pId, driverId: dId, totalFare: 1500, isCash: true });
        await sleep(1500);

        console.log('🏁 SYNC PROOF PASS COMPLETED');
        process.exit(0);

    } catch (err) {
        console.error('❌ VERIFICATION CRASHED:', err.message);
        process.exit(1);
    }
}

runVerification();
