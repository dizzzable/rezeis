#!/bin/bash
# ============================================================
# Rezeis Panel - Deployment Script
# ============================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKER_COMPOSE_FILE="$PROJECT_DIR/docker/docker-compose.yml"
ENV_FILE="$PROJECT_DIR/.env"

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_step() {
    echo -e "\n${BLUE}=== $1 ===${NC}"
}

# Function to check prerequisites
check_prerequisites() {
    print_step "Checking Prerequisites"
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        exit 1
    fi
    
    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        print_error "Docker Compose is not installed"
        exit 1
    fi
    
    # Check environment file
    if [ ! -f "$ENV_FILE" ]; then
        print_error "Environment file not found: $ENV_FILE"
        print_status "Copy .env.production.example to .env and configure it"
        exit 1
    fi
    
    # Check SSL certificates
    if [ ! -d "$PROJECT_DIR/nginx/ssl" ]; then
        print_warning "SSL directory not found. Creating..."
        mkdir -p "$PROJECT_DIR/nginx/ssl"
    fi
    
    print_status "All prerequisites satisfied"
}

# Function to build images
build_images() {
    print_step "Building Docker Images"
    
    export COMPOSE_PROJECT_NAME=rezeis-panel
    
    docker-compose -f "$DOCKER_COMPOSE_FILE" build --no-cache
    
    print_status "Images built successfully"
}

# Function to run migrations
run_migrations() {
    print_step "Running Database Migrations"
    
    # Wait for database to be ready
    print_status "Waiting for database..."
    
    MAX_RETRIES=30
    RETRY_COUNT=0
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if docker-compose -f "$DOCKER_COMPOSE_FILE" exec -T postgres pg_isready -U altshop > /dev/null 2>&1; then
            print_status "Database is ready!"
            break
        fi
        
        RETRY_COUNT=$((RETRY_COUNT + 1))
        print_warning "Database not ready yet. Retrying ($RETRY_COUNT/$MAX_RETRIES)..."
        sleep 2
    done
    
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        print_error "Database failed to start"
        exit 1
    fi
    
    # Run migrations
    if [ -x "$SCRIPT_DIR/migrate.sh" ]; then
        "$SCRIPT_DIR/migrate.sh"
    else
        print_warning "Migration script not found or not executable"
    fi
}

# Function to start services
start_services() {
    print_step "Starting Services"
    
    docker-compose -f "$DOCKER_COMPOSE_FILE" up -d --remove-orphans
    
    print_status "Services started"
}

# Function to wait for health checks
wait_for_health() {
    print_step "Waiting for Health Checks"
    
    MAX_RETRIES=30
    
    # Check backend
    print_status "Checking backend health..."
    RETRY_COUNT=0
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
            print_status "Backend is healthy!"
            break
        fi
        
        RETRY_COUNT=$((RETRY_COUNT + 1))
        print_warning "Backend not ready yet. Retrying ($RETRY_COUNT/$MAX_RETRIES)..."
        sleep 2
    done
    
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        print_error "Backend failed health check"
        return 1
    fi
    
    # Check frontend
    print_status "Checking frontend health..."
    RETRY_COUNT=0
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if curl -sf http://localhost/ > /dev/null 2>&1; then
            print_status "Frontend is healthy!"
            break
        fi
        
        RETRY_COUNT=$((RETRY_COUNT + 1))
        print_warning "Frontend not ready yet. Retrying ($RETRY_COUNT/$MAX_RETRIES)..."
        sleep 2
    done
    
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        print_error "Frontend failed health check"
        return 1
    fi
    
    print_status "All services are healthy!"
}

# Function to stop services
stop_services() {
    print_step "Stopping Services"
    
    docker-compose -f "$DOCKER_COMPOSE_FILE" down
    
    print_status "Services stopped"
}

# Function to view logs
view_logs() {
    print_step "Viewing Logs"
    
    local service="${1:-}"
    
    if [ -n "$service" ]; then
        docker-compose -f "$DOCKER_COMPOSE_FILE" logs -f "$service"
    else
        docker-compose -f "$DOCKER_COMPOSE_FILE" logs -f
    fi
}

# Function to update deployment
update() {
    print_step "Updating Deployment"
    
    # Pull latest images
    print_status "Pulling latest images..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" pull
    
    # Restart services
    print_status "Restarting services..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" up -d --remove-orphans
    
    # Run migrations
    run_migrations
    
    # Wait for health checks
    wait_for_health
    
    # Cleanup old images
    print_status "Cleaning up old images..."
    docker image prune -af --filter "until=24h" > /dev/null 2>&1 || true
    
    print_status "Update completed!"
}

# Function to show status
show_status() {
    print_step "Deployment Status"
    
    echo ""
    echo "Container Status:"
    docker-compose -f "$DOCKER_COMPOSE_FILE" ps
    
    echo ""
    echo "Resource Usage:"
    docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"
}

# Main script
main() {
    case "${1:-deploy}" in
        deploy|start)
            check_prerequisites
            build_images
            start_services
            run_migrations
            wait_for_health
            print_step "Deployment Complete!"
            print_status "Frontend: http://localhost"
            print_status "API: http://localhost:3001"
            ;;
        update|upgrade)
            check_prerequisites
            update
            print_step "Update Complete!"
            ;;
        stop)
            stop_services
            ;;
        restart)
            stop_services
            start_services
            wait_for_health
            print_status "Restart complete!"
            ;;
        logs)
            view_logs "$2"
            ;;
        status)
            show_status
            ;;
        migrate)
            run_migrations
            ;;
        build)
            build_images
            ;;
        help|--help|-h)
            echo "Usage: $0 [command] [options]"
            echo ""
            echo "Commands:"
            echo "  deploy       Deploy the application (default)"
            echo "  update       Update to latest version"
            echo "  stop         Stop all services"
            echo "  restart      Restart all services"
            echo "  logs [svc]   View logs (optionally for specific service)"
            echo "  status       Show deployment status"
            echo "  migrate      Run database migrations"
            echo "  build        Build Docker images"
            echo "  help         Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0 deploy                    # Full deployment"
            echo "  $0 update                    # Update to latest"
            echo "  $0 logs backend              # View backend logs"
            ;;
        *)
            print_error "Unknown command: $1"
            echo "Use '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
