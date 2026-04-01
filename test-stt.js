const http = require('http');

const data = JSON.stringify({
  model: 'gemini-2.5-flash',
  contents: [{ role: 'user', parts: [{ text: 'Hello, testing 1 2 3. Keep it to one short sentence.' }] }],
  voiceInput: true
});

const req = http.request('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
}, (res) => {
  res.on('data', (c) => process.stdout.write(c));
});

req.write(data);
req.end();
