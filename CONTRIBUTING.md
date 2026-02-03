# Contributing to Rezeis

Thank you for your interest in contributing to Rezeis! We welcome contributions from the community and are pleased to have you join us.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)
- [Security Issues](#security-issues)

## 📜 Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 16
- Valkey 8 (Redis-compatible)

### Setup Development Environment

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/rezeis.git
   cd rezeis
   ```

2. **Start infrastructure services**
   ```bash
   docker network create remnawave-network
   docker-compose up -d postgres valkey
   ```

3. **Install dependencies**
   ```bash
   # Install backend dependencies
   cd backend && npm install
   
   # Install frontend dependencies
   cd .. && npm install
   ```

4. **Setup environment variables**
   ```bash
   cp backend/.env.example backend/.env
   cp .env.example .env
   # Edit the .env files with your configuration
   ```

5. **Run database migrations**
   ```bash
   cd backend && npx prisma migrate dev
   ```

6. **Start development servers**
   ```bash
   # Terminal 1 - Backend
   cd backend && npm run dev
   
   # Terminal 2 - Frontend  
   npm run dev
   ```

## 🔄 Development Workflow

### Branch Naming Convention

- `feature/` - New features (e.g., `feature/user-profile`)
- `bugfix/` - Bug fixes (e.g., `bugfix/login-error`)
- `hotfix/` - Critical fixes for production (e.g., `hotfix/security-patch`)
- `docs/` - Documentation updates (e.g., `docs/api-guide`)

### Commit Message Format

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

Types:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only changes
- `style` - Code style changes (formatting, semicolons, etc.)
- `refactor` - Code refactoring
- `perf` - Performance improvements
- `test` - Adding or updating tests
- `chore` - Build process or auxiliary tool changes

Examples:
```
feat(auth): add Telegram WebApp authentication

fix(subscription): handle expired trial users correctly

docs(api): update WebSocket documentation
```

## 📝 Coding Standards

### TypeScript Guidelines

- Use TypeScript for all code
- Always declare types for function parameters and return values
- Avoid using `any` - create proper types instead
- Use interfaces for object shapes
- Prefer `const` over `let`

### Code Style

- **Frontend**: Use functional components with hooks
- **Backend**: Follow Fastify best practices
- **Naming**: 
  - PascalCase for components and classes
  - camelCase for variables and functions
  - UPPERCASE for constants
- **Comments**: Use JSDoc for public functions and classes

### Linting

```bash
# Run linter
npm run lint

# Run type checking
npm run typecheck
```

### Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

## 📤 Submitting Changes

### Pull Request Process

1. **Update documentation** - Ensure all documentation is updated for any API changes
2. **Add tests** - Write tests for new functionality
3. **Update CHANGELOG.md** - Document your changes
4. **Ensure tests pass** - Run the full test suite
5. **Submit PR** - Create a pull request with a clear description

### PR Checklist

- [ ] Code follows the style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] Tests added and passing
- [ ] No console errors or warnings
- [ ] Branch is up to date with `main`

### Review Process

- All PRs require at least one review from a maintainer
- Address review comments promptly
- Maintainers may request changes or provide feedback
- Once approved, a maintainer will merge your PR

## 🐛 Reporting Issues

### Bug Reports

When reporting bugs, please include:

- **Clear description** - What happened vs. what you expected
- **Steps to reproduce** - Detailed steps to recreate the issue
- **Environment** - OS, Node.js version, browser (if applicable)
- **Screenshots** - If applicable
- **Logs** - Relevant error messages or stack traces

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) when creating issues.

### Feature Requests

When requesting features, please include:

- **Clear description** - What feature you want and why
- **Use case** - How this feature would be used
- **Proposed solution** - Your ideas on implementation (optional)

Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md) when creating issues.

## 🔒 Security Issues

**Do not create public issues for security vulnerabilities.**

Instead, please email security concerns to: security@rezeis.local

Include:
- Description of the vulnerability
- Steps to reproduce (if applicable)
- Possible impact
- Suggested fix (if any)

We will respond within 48 hours and work on a fix.

## 🙏 Recognition

Contributors will be recognized in our README.md file and release notes.

Thank you for contributing to Rezeis!
