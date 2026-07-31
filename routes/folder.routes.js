const express = require('express');

const FolderController = require('../controllers/folder.controller');
const authMiddleware = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/:id', FolderController.getFolder);
router.get('/', FolderController.getFolders);

router.post('/', FolderController.create);

router.patch('/:id', FolderController.rename);

router.post('/:id/copy', FolderController.copy);

router.delete('/:id', FolderController.delete);

module.exports = router;
