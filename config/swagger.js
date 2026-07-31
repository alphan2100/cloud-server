const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Cloud Storage API',
      version: '1.0.0',
      description: 'Dokumentasi API untuk Cloud Storage Server',
      contact: {
        name: 'Developer',
      },
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3000}`,
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            code: { type: 'string' },
            message: { type: 'string' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            username: { type: 'string' },
          },
        },
        File: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            original_filename: { type: 'string' },
            file_size: { type: 'integer' },
            mime_type: { type: 'string' },
            uploaded_at: { type: 'string', format: 'date-time' },
          },
        },
        Folder: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            folder_name: { type: 'string' },
            parent_id: { type: 'integer', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
  apis: ['./routes/*.js', './controllers/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;