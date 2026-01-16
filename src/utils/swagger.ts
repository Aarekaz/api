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
    }
  </style>
</head>
<body>
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
