/**
 * Swagger UI HTML template generator
 * Serves Swagger UI with CDN-hosted assets for Cloudflare Workers
 */

export function getSwaggerUiHtml(openapiUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Documentation - Personal API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #fafafa;
    }
    .swagger-ui .topbar {
      display: none;
    }
    #swagger-ui {
      max-width: 1460px;
      margin: 0 auto;
    }
    .custom-header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 2rem;
      text-align: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .custom-header h1 {
      margin: 0 0 0.5rem 0;
      font-size: 2rem;
      font-weight: 600;
    }
    .custom-header p {
      margin: 0;
      opacity: 0.9;
      font-size: 1.1rem;
    }
  </style>
</head>
<body>
  <div class="custom-header">
    <h1>Personal API Documentation</h1>
    <p>Interactive API documentation with live testing capabilities</p>
  </div>
  <div id="swagger-ui"></div>

  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: '${openapiUrl}',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
        docExpansion: 'list',
        filter: true,
        displayRequestDuration: true,
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: 'StandaloneLayout',
        validatorUrl: null,
        onComplete: function() {
          console.log('Swagger UI loaded successfully');
          // Auto-focus on auth button for better UX
          const authButton = document.querySelector('.auth-wrapper .authorize');
          if (authButton) {
            console.log('Click "Authorize" to enter your Bearer token for interactive testing');
          }
        }
      });
    };
  </script>
</body>
</html>
  `.trim();
}
