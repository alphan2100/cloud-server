// webdav.routes.js
const express = require('express');
const router = express.Router();

const webdavAuth = require('../middlewares/webdav-auth.middleware');
const WebDAVController = require('../controllers/webdav.controller');

router.use(webdavAuth);

// ✅ Root path handlers
router.options('/', WebDAVController.options);
router.get('/', WebDAVController.get);
router.head('/', WebDAVController.head);
router.put('/', WebDAVController.put);
router.delete('/', WebDAVController.delete);
router.propfind('/', WebDAVController.propfind);
router.mkcol('/', WebDAVController.mkcol);
router.move('/', WebDAVController.move);
router.copy('/', WebDAVController.copy);
router.lock('/', WebDAVController.lock);
router.unlock('/', WebDAVController.unlock);

// ✅ Wildcard sub-path handlers (Express 5 requires /*splat syntax)
router.options('/*splat', WebDAVController.options);
router.get('/*splat', WebDAVController.get);
router.head('/*splat', WebDAVController.head);
router.put('/*splat', WebDAVController.put);
router.delete('/*splat', WebDAVController.delete);
router.propfind('/*splat', WebDAVController.propfind);
router.mkcol('/*splat', WebDAVController.mkcol);
router.move('/*splat', WebDAVController.move);
router.copy('/*splat', WebDAVController.copy);
router.lock('/*splat', WebDAVController.lock);
router.unlock('/*splat', WebDAVController.unlock);

module.exports = router;
