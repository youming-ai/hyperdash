package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/hyperdash/copy-engine/internal/engine"
)

// SetupRouter creates a Gin engine with health endpoints.
// Takes *engine.Engine to satisfy main.go wire-up; logic is stubbed.
func SetupRouter(_ *engine.Engine) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	r.GET("/ready", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ready": true})
	})

	return r
}
