const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const MoveController = require('../controllers/move.controller');

router.use(authMiddleware);

// Move endpoints
router.put('/file/:id', MoveController.moveFile);
router.put('/folder/:id', MoveController.moveFolder);

// Copy endpoints
router.post('/file/:id', MoveController.copyFile);
router.post('/folder/:id', MoveController.copyFolder);

module.exports = router;
