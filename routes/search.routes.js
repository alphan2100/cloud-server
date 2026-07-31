const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const SearchController = require('../controllers/search.controller');

router.get('/', authMiddleware, SearchController.search);

module.exports = router;