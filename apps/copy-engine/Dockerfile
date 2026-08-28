# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git ca-certificates tzdata

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main cmd/server/main.go

# Production stage
FROM alpine:latest

# Install ca-certificates for HTTPS requests
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN addgroup --system --gid 1001 appuser && \
    adduser --system --uid 1001 -G appuser appuser

WORKDIR /app

# Copy binary from builder stage
COPY --from=builder /app/main .

# Set permissions
RUN chown appuser:appuser main

USER appuser

EXPOSE 8080

CMD ["./main"]
