#!/bin/bash
# ============================================================
# Altshop Panel - Database Backup Script
# ============================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS=${RETENTION_DAYS:-30}

# Load environment variables
if [ -f "$PROJECT_DIR/.env" ]; then
    export $(cat "$PROJECT_DIR/.env" | grep -v '^#' | xargs)
fi

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

# Function to create backup
create_backup() {
    local backup_name="${1:-backup_$(date +%Y%m%d_%H%M%S)}"
    local backup_file="$BACKUP_DIR/${backup_name}.sql"
    
    print_status "Creating backup: $backup_name"
    
    # Create backup directory if not exists
    mkdir -p "$BACKUP_DIR"
    
    # Check if DATABASE_URL is set
    if [ -z "$DATABASE_URL" ]; then
        print_error "DATABASE_URL is not set"
        exit 1
    fi
    
    # Create backup
    if pg_dump "$DATABASE_URL" > "$backup_file"; then
        # Compress backup
        gzip "$backup_file"
        backup_file="${backup_file}.gz"
        
        local file_size=$(du -h "$backup_file" | cut -f1)
        print_status "Backup created successfully: $backup_file ($file_size)"
        
        # Clean old backups
        cleanup_old_backups
        
        return 0
    else
        print_error "Failed to create backup"
        rm -f "$backup_file"
        return 1
    fi
}

# Function to restore backup
restore_backup() {
    local backup_file="$1"
    
    if [ -z "$backup_file" ]; then
        print_error "Backup file is required"
        echo "Usage: $0 restore <backup_file>"
        list_backups
        exit 1
    fi
    
    # Check if file exists
    if [ ! -f "$backup_file" ]; then
        # Try to find in backup directory
        if [ -f "$BACKUP_DIR/$backup_file" ]; then
            backup_file="$BACKUP_DIR/$backup_file"
        else
            print_error "Backup file not found: $backup_file"
            list_backups
            exit 1
        fi
    fi
    
    print_warning "This will overwrite the current database!"
    read -p "Are you sure you want to continue? (yes/no): " confirm
    
    if [ "$confirm" != "yes" ]; then
        print_status "Restore cancelled"
        exit 0
    fi
    
    print_status "Restoring from backup: $backup_file"
    
    # Decompress if gzipped
    local temp_file="$backup_file"
    if [[ "$backup_file" == *.gz ]]; then
        temp_file="/tmp/backup_$(date +%s).sql"
        gunzip -c "$backup_file" > "$temp_file"
        trap "rm -f $temp_file" EXIT
    fi
    
    # Restore database
    if psql "$DATABASE_URL" < "$temp_file"; then
        print_status "Database restored successfully!"
        return 0
    else
        print_error "Failed to restore database"
        return 1
    fi
}

# Function to list backups
list_backups() {
    print_status "Available backups in $BACKUP_DIR:"
    
    if [ ! -d "$BACKUP_DIR" ]; then
        print_warning "Backup directory does not exist"
        return 0
    fi
    
    echo ""
    printf "%-30s %-10s %-20s\n" "FILENAME" "SIZE" "DATE"
    echo "--------------------------------------------------------"
    
    ls -1t "$BACKUP_DIR"/*.sql* 2>/dev/null | while read file; do
        local filename=$(basename "$file")
        local size=$(du -h "$file" | cut -f1)
        local date=$(stat -c %y "$file" 2>/dev/null | cut -d' ' -f1,2 | cut -d'.' -f1 || stat -f %Sm "$file" 2>/dev/null)
        printf "%-30s %-10s %-20s\n" "$filename" "$size" "$date"
    done
}

# Function to cleanup old backups
cleanup_old_backups() {
    print_status "Cleaning up backups older than $RETENTION_DAYS days..."
    
    find "$BACKUP_DIR" -name "*.sql*" -mtime +$RETENTION_DAYS -type f -delete
    print_status "Cleanup completed"
}

# Function to schedule backup (add to crontab)
schedule_backup() {
    local schedule="${1:-0 2 * * *}"  # Default: daily at 2 AM
    
    print_status "Scheduling backup with cron: $schedule"
    
    # Add to crontab
    (crontab -l 2>/dev/null; echo "$schedule $SCRIPT_DIR/backup.sh") | crontab -
    
    print_status "Backup scheduled successfully!"
    print_status "Current crontab:"
    crontab -l | grep backup.sh
}

# Main script
main() {
    case "${1:-create}" in
        create|backup)
            create_backup "$2"
            ;;
        restore)
            restore_backup "$2"
            ;;
        list|ls)
            list_backups
            ;;
        cleanup)
            cleanup_old_backups
            ;;
        schedule)
            schedule_backup "$2"
            ;;
        help|--help|-h)
            echo "Usage: $0 [command] [options]"
            echo ""
            echo "Commands:"
            echo "  create [name]     Create a new backup"
            echo "  restore <file>    Restore from backup"
            echo "  list              List all backups"
            echo "  cleanup           Remove old backups"
            echo "  schedule [cron]   Schedule automatic backups"
            echo "  help              Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  DATABASE_URL      Database connection string"
            echo "  BACKUP_DIR        Backup directory (default: ./backups)"
            echo "  RETENTION_DAYS    Days to keep backups (default: 30)"
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
