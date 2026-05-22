const { exec } = require('child_process');
exec('ffmpeg -version', (err, stdout, stderr) => {
    if (err) console.log("ffmpeg not found");
    else console.log("ffmpeg found");
});
