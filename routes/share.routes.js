const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const ShareController = require('../controllers/share.controller');

// Public endpoints (tanpa auth)
router.get('/access/:token', ShareController.access);
router.get('/access/:token/download', ShareController.downloadSharedFile);
router.get('/access/:token/stream', ShareController.streamFile);

// Protected endpoints (perlu auth)
router.use(authMiddleware);

router.get('/', ShareController.list);
router.post('/', ShareController.create);
router.delete('/:id', ShareController.delete);

module.exports = router;