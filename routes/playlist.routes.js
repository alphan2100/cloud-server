const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const PlaylistController = require('../controllers/playlist.controller');

// All routes require auth
router.use(authMiddleware);

// CRUD Playlist
router.get('/', PlaylistController.list);
router.post('/', PlaylistController.create);
router.get('/:id', PlaylistController.getById);
router.put('/:id', PlaylistController.update);
router.delete('/:id', PlaylistController.delete);

// Track management dalam playlist
router.post('/:id/tracks', PlaylistController.addTracks);
router.delete('/:id/tracks/:trackId', PlaylistController.removeTrack);
router.put('/:id/reorder', PlaylistController.reorder);

module.exports = router;