const { downloadVideo } = require('./src/services/videoAgent'); // I will modify videoAgent to export it just to test, or I'll just write a mock
const { execFile } = require('child_process');

async function test() {
    execFile('src/bin/yt-dlp', ['--version'], (err, stdout, stderr) => {
        console.log("YT-DLP Version:", stdout);
    });
}
test();
