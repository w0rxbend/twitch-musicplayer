package api

import (
	_ "embed"
	"net/http"
)

//go:embed openapi.yaml
var openAPISpec []byte

const swaggerHTML = `<!DOCTYPE html>
<html>
<head>
  <title>Lofi Radio — API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>body { margin: 0; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
<script>
window.onload = function() {
  SwaggerUIBundle({
    url: "/openapi.yaml",
    dom_id: "#swagger-ui",
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: "StandaloneLayout",
    deepLinking: true,
  });
};
</script>
</body>
</html>`

// ServeSwagger serves the Swagger UI HTML page at GET /swagger.
func ServeSwagger(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(swaggerHTML)) //nolint:errcheck
}

// ServeOpenAPISpec serves the raw OpenAPI YAML at GET /openapi.yaml.
func ServeOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	w.Write(openAPISpec) //nolint:errcheck
}
