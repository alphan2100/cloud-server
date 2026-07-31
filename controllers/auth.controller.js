const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const UserModel = require('../models/user.model');

const AuthController = {
  async login(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Username dan password wajib diisi'
        });
      }

      const user = await UserModel.findByUsername(username);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Username atau password salah'
        });
      }

      const isMatch = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Username atau password salah'
        });
      }

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username
        },
        process.env.JWT_SECRET,
        {
          expiresIn: process.env.JWT_EXPIRES_IN || '7d'
        }
      );

      return res.json({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username
        }
      });

    } catch (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
};

module.exports = AuthController;