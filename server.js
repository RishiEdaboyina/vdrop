const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── /api/info  ────────────────────────────────────────────────
// Returns title, thumbnail, duration, uploader + simplified format list
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Please enter a valid URL.' });
  }

  const cmd = `yt-dlp --dump-json --no-playlist --flat-playlist "${url}"`;
  exec(cmd, { timeout: 30000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(500).json({ error: 'Could not fetch video info. Check the URL and try again.' });
    }
    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);

      // Build a clean, deduplicated quality list
      const seen = new Set();
      const qualities = [];

      // Add best combined formats first
      const presets = [
        { id: 'best',                                           label: 'Best Quality',  tag: 'AUTO',  type: 'video' },
        { id: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]', label: '4K — 2160p', tag: '4K',    type: 'video' },
        { id: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', label: 'Full HD — 1080p', tag: 'HD',  type: 'video' },
        { id: 'bestvideo[height<=720]+bestaudio/best[height<=720]',   label: 'HD — 720p',     tag: '720p', type: 'video' },
        { id: 'bestvideo[height<=480]+bestaudio/best[height<=480]',   label: 'SD — 480p',     tag: '480p', type: 'video' },
        { id: 'bestvideo[height<=360]+bestaudio/best[height<=360]',   label: 'Low — 360p',    tag: '360p', type: 'video' },
      ];

      presets.forEach(p => {
        if (!seen.has(p.tag)) {
          seen.add(p.tag);
          qualities.push(p);
        }
      });

      // Audio formats
      ['mp3', 'm4a', 'opus', 'flac'].forEach(fmt => {
        qualities.push({ id: `audio_${fmt}`, label: fmt.toUpperCase(), tag: fmt.toUpperCase(), type: 'audio', audioFmt: fmt });
      });

      res.json({
        title:     info.title     || 'Unknown Title',
        thumbnail: info.thumbnail || null,
        duration:  info.duration  || 0,
        uploader:  info.uploader  || info.channel || '',
        platform:  info.extractor_key || '',
        qualities,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info.' });
    }
  });
});

// ── /api/download  ───────────────────────────────────────────
// Runs yt-dlp, streams file directly to browser
app.post('/api/download', (req, res) => {
  const { url, qualityId, audioFmt } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  const tmpDir = os.tmpdir();
  const outputTemplate = path.join(tmpDir, `vdrop_${Date.now()}_%(title).80B.%(ext)s`);

  const args = ['--no-playlist', '-o', outputTemplate];

  if (qualityId && qualityId.startsWith('audio_')) {
    args.push('-x', '--audio-format', audioFmt || 'mp3', '--audio-quality', '0');
  } else if (qualityId && qualityId !== 'best') {
    args.push('-f', qualityId, '--merge-output-format', 'mp4');
  } else {
    args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
  }

  args.push('--print', 'after_move:filepath', url);

  let outputPath = '';
  let errOut = '';

  const proc = spawn('yt-dlp', args);
  proc.stdout.on('data', d => {
    const line = d.toString().trim();
    if (line && fs.existsSync(line)) outputPath = line;
  });
  proc.stderr.on('data', d => { errOut += d.toString(); });

  proc.on('close', code => {
    if (code !== 0 || !outputPath) {
      console.error('yt-dlp error:', errOut);
      return res.status(500).json({ error: 'Download failed. The platform may not be supported or the URL is private.' });
    }

    const filename = path.basename(outputPath);
    const stat = fs.statSync(outputPath);

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(outputPath, () => {}));
    stream.on('error', () => res.status(500).end());
  });
});

app.listen(PORT, () => console.log(`✅  VDROP running on http://localhost:${PORT}`));
