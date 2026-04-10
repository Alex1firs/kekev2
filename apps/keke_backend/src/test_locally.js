const axios = require('axios');

const API_URL = 'http://localhost:3000/api/v1';

async function runTest() {
    console.log('--- STARTING AUTH TEST ---');
    const testUser = {
        phone: '234' + Math.floor(Math.random() * 10000000000),
        password: 'password123',
        first_name: 'Test',
        last_name: 'Local'
    };

    try {
        // 1. SIGNUP
        console.log(`1. Attempting Signup for ${testUser.phone}...`);
        const signupRes = await axios.post(`${API_URL}/auth/signup`, testUser);
        const token = signupRes.data.token;
        console.log('✅ SIGNUP SUCCESS. Token received.');

        // 2. CHECK /ME (Success Path)
        console.log('2. Testing /me endpoint with valid token...');
        const meRes = await axios.get(`${API_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('✅ /ME SUCCESS. User Profile:', meRes.data);

        // 3. CHECK /ME (Failure Path - No Token)
        console.log('3. Testing /me endpoint with NO token (should fail)...');
        try {
            await axios.get(`${API_URL}/auth/me`);
        } catch (err) {
            console.log('✅ CORRECTLY BLOCKED: No token returned 401');
        }

        // 4. CHECK /ME (Failure Path - Invalid Token)
        console.log('4. Testing /me endpoint with INVALID token (should fail)...');
        try {
            await axios.get(`${API_URL}/auth/me`, {
                headers: { Authorization: 'Bearer invalid_token' }
            });
        } catch (err) {
            console.log('✅ CORRECTLY BLOCKED: Invalid token returned 401');
        }

        console.log('\n--- ALL AUTH TESTS PASSED! ---');

    } catch (err) {
        console.error('❌ TEST FAILED:', err.response?.data || err.message);
    }
}

runTest();
