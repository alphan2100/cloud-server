const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

// Codec audio yang aman diputar langsung oleh <video> HTML5 di browser
// (AAC & MP3 hampir universal, Opus didukung untuk kontainer mp4/webm modern)
const BROWSER_SAFE_AUDIO_CODECS = ['aac', 'mp3', 'opus'];

/**
 * Ambil info stream (video & audio codec) dari file menggunakan ffprobe
 * @param {string} inputPath
 * @returns {Promise<{videoCodec: string|null, audioCodec: string|null, hasAudio: boolean}>}
 */
function probeStreams(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(new Error(`Gagal membaca info file: ${err.message}`));

      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');

      resolve({
        videoCodec: videoStream ? videoStream.codec_name : null,
        audioCodec: audioStream ? audioStream.codec_name : null,
        hasAudio: !!audioStream,
      });
    });
  });
}

/**
 * Remux video file to be streaming-friendly (moov atom at front)
 * Menggunakan ffmpeg -c copy -movflags faststart agar cepat (tanpa re-encode)
 *
 * Jika audio codec tidak didukung browser (mis. AC3, DTS, FLAC, Vorbis-in-mkv),
 * audio akan ditranscode ke AAC. Video tetap di-copy (tidak re-encode) selama
 * codec videonya sudah H.264/H.265 yang umum didukung, sehingga proses tetap ringan.
 *
 * @param {string} inputPath - Path file video asli
 * @param {string} outputPath - Path file hasil remux (bisa sama dengan inputPath)
 * @returns {Promise<string>} - Path file hasil remux
 */
async function remuxVideo(inputPath, outputPath) {
  const { audioCodec, hasAudio } = await probeStreams(inputPath);

  const needsAudioTranscode =
    hasAudio && !BROWSER_SAFE_AUDIO_CODECS.includes((audioCodec || '').toLowerCase());

  return new Promise((resolve, reject) => {
    // Jika input dan output sama, gunakan file temp
    let finalOutputPath = outputPath;
    let tempPath = null;

    if (inputPath === outputPath) {
      const ext = path.extname(inputPath);
      const dir = path.dirname(inputPath);
      const base = path.basename(inputPath, ext);
      tempPath = path.join(dir, `${base}_remuxing${ext}`);
      finalOutputPath = tempPath;
    }

    const outputOptions = ['-c:v copy'];

    if (!hasAudio) {
      // Tidak ada audio sama sekali, tidak perlu opsi audio
    } else if (needsAudioTranscode) {
      // Audio codec tidak didukung browser -> transcode ke AAC (ringan, audio-only)
      outputOptions.push('-c:a aac', '-b:a 192k');
    } else {
      // Audio codec sudah aman -> copy saja, tidak perlu re-encode
      outputOptions.push('-c:a copy');
    }

    outputOptions.push('-movflags faststart');

    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .on('end', () => {
        // Jika menggunakan file temp, ganti file asli
        if (tempPath) {
          try {
            fs.renameSync(tempPath, outputPath);
          } catch (err) {
            return reject(new Error(`Gagal mengganti file hasil remux: ${err.message}`));
          }
        }
        resolve(outputPath);
      })
      .on('error', (err) => {
        // Hapus file temp jika ada error
        if (tempPath && fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
        }
        reject(new Error(`Gagal meremux video: ${err.message}`));
      })
      .save(finalOutputPath);
  });
}

/**
 * Cek apakah file adalah video berdasarkan mime type
 */
function isVideoFile(mimeType) {
  if (!mimeType) return false;
  return mimeType.startsWith('video/');
}

module.exports = {
  remuxVideo,
  isVideoFile,
  probeStreams,
};