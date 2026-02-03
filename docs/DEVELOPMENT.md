# Development Guide

This guide covers development setup, architecture, and best practices for Rezeis.

## 📋 Table of Contents

- [Project Structure](#project-structure)
- [Development Environment](#development-environment)
- [Architecture Overview](#architecture-overview)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Contributing](#contributing)
- [Debugging](#debugging)

## 📁 Project Structure

```
rezeis-panel/
├── backend/                    # Fastify API server
│   ├── src/
│   │   ├── config/           # Configuration files
│   │   │   ├── env.ts        # Environment variables
│   │   │   ├── database.ts   # Database config
│   │   │   ├── redis.ts      # Valkey config
│   │   │   └── swagger.ts    # API docs
│   │   ├── modules/          # Feature modules
│   │   │   ├── auth/         # Authentication
│   │   │   ├── users/        # User management
│   │   │   ├── subscriptions/
│   │   │   ├── partners/
│   │   │   ├── promocodes/
│   │   │   ├── monitoring/
│   │   │   ├── notifications/
│   │   │   ├── referrals/
│   │   │   ├── banners/
│   │   │   ├── backups/
│   │   │   ├── broadcasts/
│   │   │   ├── access/
│   │   │   ├── gateways/
│   │   │   ├── client/
│   │   │   ├── admin/
│   │   │   ├── health/
│   │   │   ├── remnawave/
│   │   │   ├── payments/
│   │   │   └── multisubscriptions/
│   │   ├── services/         # Business logic
│   │   ├── repositories/     # Data access
│   │   ├── entities/         # Type definitions
│   │   ├── middleware/       # Express middleware
│   │   ├── cache/           # Caching layer
│   │   ├── events/          # Event system
│   │   ├── jobs/            # Background jobs
│   │   ├── websocket/       # WebSocket server
│   │   └── database/
│   │       └── migrations/   # SQL migrations
│   └── prisma/              # ORM schema
├── src/                      # React frontend
│   ├── api/                 # API client
│   ├── components/          # Reusable components
│   ├── pages/              # Page components
│   ├── stores/              # Zustand stores
│   ├── themes/              # Theme definitions
│   ├── hooks/               # Custom hooks
│   ├── types/               # TypeScript types
│   ├── utils/               # Utilities
│   └── locales/             # i18n translations
├── docs/                    # Documentation
├── examples/                 # Configuration examples
├── scripts/                 # Deployment scripts
└── package.json
```

## 🛠️ Development Environment

### Prerequisites

| Tool | Version | Description |
|------|---------|-------------|
| Node.js | 20+ | JavaScript runtime |
| Docker | 24+ | Container platform |
| PostgreSQL | 16+ | Database |
| Valkey | 8+ | Cache (Redis-compatible) |
| Git | 2.0+ | Version control |

### Quick Start

```bash
# 1. Clone repository
git clone https://github.com/dizzable/rezeis.git
cd rezeis

# 2. Start infrastructure
docker network create remnawave-network
docker-compose up -d postgres valkey

# 3. Install dependencies
cd backend && npm install
cd ../ && npm install

# 4. Setup environment
cp backend/.env.example backend/.env
cp .env.example .env

# 5. Run migrations
cd backend && npx prisma migrate dev

# 6. Start development servers
# Terminal 1
cd backend && npm run dev

# Terminal 2
npm run dev
```

### Development Ports

| Service | Port | URL |
|---------|------|-----|
| Frontend | 5173 | http://localhost:5173 |
| Backend API | 4001 | http://localhost:4001 |
| API Docs | 4001/api/docs | http://localhost:4001/api/docs |

## 🏗️ Architecture Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React)                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐   │
│  │  Pages  │ │Components│ │ Stores  │ │  API Services   │   │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────────┬────────┘   │
└───────┼───────────┼───────────┼────────────────┼───────────┘
        │           │           │                │
        └───────────┴───────────┴────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Backend (Fastify)                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐   │
│  │ Controllers│ │ Services │ │  Jobs   │ │  Middleware     │   │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────────┬────────┘   │
└───────┼───────────┼───────────┼────────────────┼───────────┘
        │           │           │                │
        ▼           ▼           ▼                ▼
┌─────────────────────────────────────────────────────────────┐
│                      Data Layer                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐   │
│  │PostgreSQL│ │ Valkey  │ │ Events  │ │  Webhooks       │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    External Services                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐   │
│  │Remnawave │ │ Telegram │ │ Payment  │ │  Monitoring     │   │
│  │          │ │          │ │ Gateways │ │                 │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **API Request Flow**
   ```
   Client → Nginx → Backend → Service → Repository → Database
                         ↓
                       Cache
                         ↓
                     Response
   ```

2. **Event Flow**
   ```
   Trigger → Event Service → Event Bus → Subscribers → Actions
                     ↓
               Persistence
   ```

## 📝 Coding Standards

### TypeScript Guidelines

```typescript
// ✅ Good: Explicit types
function createUser(input: CreateUserInput): Promise<User> {
  // ...
}

// ❌ Bad: Implicit any
function createUser(input) {
  // ...
}

// ✅ Good: Interface for objects
interface User {
  id: string;
  username: string;
  email: string;
  role: UserRole;
}

// ❌ Bad: Type for objects
type User = {
  id: string;
  username: string;
  // ...
};
```

### Fastify Best Practices

```typescript
// ✅ Good: Use schema for validation
const createUserSchema = {
  body: {
    type: 'object',
    required: ['username', 'email', 'password'],
    properties: {
      username: { type: 'string', minLength: 3 },
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 }
    }
  }
};

fastify.post<{ Body: CreateUserInput }>(
  '/users',
  { schema: createUserSchema },
  async (request, reply) => {
    // Handler code
  }
);
```

### React Best Practices

```tsx
// ✅ Good: Functional component with hooks
function UserProfile({ userId }: UserProfileProps) {
  const { data: user, isLoading } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetchUser(userId)
  });

  if (isLoading) return <Spinner />;
  if (!user) return <NotFound />;

  return <UserCard user={user} />;
}

// ❌ Bad: Class component
class UserProfile extends React.Component {
  // ...
}
```

### Naming Conventions

| Type | Convention | Example |
|------|-------------|---------|
| Files | kebab-case | `user-service.ts` |
| Classes | PascalCase | `UserService` |
| Functions | camelCase | `createUser()` |
| Variables | camelCase | `userData` |
| Constants | UPPER_SNAKE_CASE | `MAX_USERS` |
| Interfaces | PascalCase | `UserInput` |
| Types | PascalCase | `UserRole` |

## 🧪 Testing

### Running Tests

```bash
# Run all tests
npm test

# Run backend tests
cd backend && npm test

# Run frontend tests
npm run test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Unit Tests

```typescript
// backend/src/services/user.service.test.ts
describe('UserService', () => {
  describe('createUser', () => {
    it('should create user successfully', async () => {
      // Arrange
      const input: CreateUserInput = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      };

      // Act
      const result = await userService.createUser(input);

      // Assert
      expect(result.username).toBe('testuser');
      expect(result.email).toBe('test@example.com');
    });
  });
});
```

### Integration Tests

```typescript
// backend/src/modules/auth/auth.test.ts
describe('Auth API', () => {
  it('should login successfully', async () => {
    // Create test user first
    await createTestUser();

    // Make login request
    const response = await request(app.server)
      .post('/api/auth/login')
      .send({
        username: 'testuser',
        password: 'password123'
      });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeDefined();
  });
});
```

### Frontend Tests

```tsx
// src/components/Button.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('should call onClick when clicked', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    
    fireEvent.click(screen.getByText('Click me'));
    
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
```

## 🤝 Contributing

### Workflow

1. **Fork** the repository
2. **Create** a feature branch: `feature/your-feature`
3. **Make** your changes
4. **Test** your changes
5. **Submit** a Pull Request

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(auth): add Telegram WebApp authentication
fix(subscription): handle expired trial users
docs(api): update WebSocket documentation
refactor(database): optimize query performance
```

### Pull Request Checklist

- [ ] Code follows style guidelines
- [ ] Tests added and passing
- [ ] Documentation updated
- [ ] No new warnings
- [ ] Related issue linked

## 🐛 Debugging

### Backend Debugging

```bash
# Enable debug logging
DEBUG=* npm run dev

# Debug specific module
DEBUG=backend:auth npm run dev

# Attach debugger
node --inspect-brk dist/index.js
```

### Frontend Debugging

```bash
# Enable source maps
npm run dev -- --debug

# React DevTools
# Install browser extension
# https://react.dev/learn/react-developer-tools
```

### Database Debugging

```bash
# View queries
LOG_QUERIES=true npm run dev

# Use Prisma Studio
npx prisma studio
```

### Docker Debugging

```bash
# Check logs
docker-compose logs -f backend

# Execute in container
docker-compose exec backend sh

# Check network
docker network inspect remnawave-network
```

## 📚 Additional Resources

- [API Documentation](API.md)
- [Feature Guide](FEATURES.md)
- [Deployment Guide](DEPLOYMENT.md)
- [Contributing Guide](../CONTRIBUTING.md)

## 📝 Notes

- Always use TypeScript
- Write tests for new features
- Document complex logic
- Follow the existing code style
- Keep PRs small and focused