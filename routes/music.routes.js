const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const MusicController = require('../controllers/music.controller');

// All routes require auth
router.use(authMiddleware);

// Scan
router.post('/scan', MusicController.scan);
router.get('/scan/:jobId/status', MusicController.getScanStatus);

// Tracks
router.get('/tracks', MusicController.listTracks);
router.get('/tracks/:id', MusicController.getTrack);
router.post('/tracks/:id/rescan', MusicController.rescanTrack);
router.put('/tracks/:id', MusicController.updateTrackMetadata);
router.get('/tracks/:id/cover', MusicController.getTrackCover);
router.post('/tracks/:id/play', MusicController.recordPlay);

// Search
router.get('/search', MusicController.search);

// Albums
router.get('/albums', MusicController.listAlbums);
router.get('/albums/:id', MusicController.getAlbum);

// Artists
router.get('/artists', MusicController.listArtists);
router.get('/artists/:id', MusicController.getArtist);

// Play history
router.get('/recent', MusicController.getRecent);
router.get('/most-played', MusicController.getMostPlayed);

// Cleanup orphaned data
router.post('/cleanup', MusicController.cleanup);

module.exports = router;