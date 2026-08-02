const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const FavoriteController = require('../controllers/favorite.controller');

// All routes require auth
router.use(authMiddleware);

// Favorite management
router.get('/', FavoriteController.list);
router.post('/:trackId', FavoriteController.toggle);
router.delete('/:trackId', FavoriteController.remove);
router.get('/check/:trackId', FavoriteController.check);

module.exports = router;