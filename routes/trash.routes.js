const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const TrashController = require('../controllers/trash.controller');

router.use(authMiddleware);

router.get('/', TrashController.getTrash);
router.post('/restore/:type/:id', TrashController.restore);
router.delete('/:type/:id', TrashController.deletePermanent);
router.delete('/empty', TrashController.emptyTrash);

module.exports = router;