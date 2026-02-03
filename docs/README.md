# Rezeis Documentation

Welcome to the Rezeis documentation! This documentation provides comprehensive information about the project.

## 📚 Documentation Contents

| Section | Description |
|---------|-------------|
| [README](README.md) | Overview of Rezeis and its features |
| [Installation](INSTALLATION.md) | Step-by-step installation guide |
| [User Guide](USER_GUIDE.md) | Comprehensive user documentation |
| [API Reference](API.md) | API endpoints and usage |
| [Features](FEATURES.md) | Detailed feature descriptions |
| [Development](DEVELOPMENT.md) | Development guide and architecture |
| [Deployment](DEPLOYMENT.md) | Production deployment guide |

## 🚀 Quick Links

- **Live Demo**: [demo.rezeis.local](https://demo.rezeis.local)
- **GitHub**: [github.com/dizzable/rezeis](https://github.com/dizzable/rezeis)
- **Issues**: [github.com/dizzable/rezeis/issues](https://github.com/dizzable/rezeis/issues)
- **Discord**: [discord.gg/rezeis](https://discord.gg/rezeis)

## 🎯 Key Features

- **Multi-subscription Management** - Manage multiple VPN subscriptions from one panel
- **Remnawave Integration** - Seamless integration with Remnawave VPN panel
- **Telegram Mini App** - Mobile-first user experience via Telegram
- **Real-time Monitoring** - WebSocket-based server monitoring
- **Partner Program** - Multi-level partnership with commission tracking
- **Promocodes** - Flexible discount system
- **Analytics** - Comprehensive statistics and reporting

## 💻 Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Tailwind CSS v4 |
| Backend | Fastify, TypeScript, PostgreSQL |
| Cache | Valkey 8 (Redis-compatible) |
| Docker | Containerized deployment |
| DevOps | Nginx, Docker Compose |

## 📖 Getting Started

### For Users

1. Read the [User Guide](USER_GUIDE.md) to learn how to use the panel
2. Check the [Installation](INSTALLATION.md) guide to set up your instance
3. Explore the [Features](FEATURES.md) to understand capabilities

### For Developers

1. Read the [Development](DEVELOPMENT.md) guide
2. Check the [API Reference](API.md)
3. Review [CONTRIBUTING.md](../CONTRIBUTING.md)
4. Fork and submit PRs

### For DevOps

1. Read the [Deployment](DEPLOYMENT.md) guide
2. Review example configurations in [examples](../examples/)
3. Set up monitoring and backups

## 🏗️ Architecture

```
rezeis/
├── backend/           # Fastify API server
│   └── src/
│       ├── config/    # Configuration
│       ├── modules/  # API modules
│       ├── services/ # Business logic
│       └── entities/ # Data types
├── src/              # React frontend
│   ├── api/          # API services
│   ├── components/   # UI components
│   ├── pages/        # Page components
│   ├── stores/       # State management
│   └── themes/       # Theme definitions
├── docs/             # Documentation
├── examples/         # Configuration examples
└── scripts/          # Deployment scripts
```

## 📄 License

Rezeis is licensed under the [MIT License](../LICENSE).

## 🤝 Support

- **Documentation**: This documentation site
- **Issues**: [GitHub Issues](https://github.com/dizzable/rezeis/issues)
- **Discussions**: [GitHub Discussions](https://github.com/dizzable/rezeis/discussions)
- **Email**: support@rezeis.local

## 🙏 Acknowledgments

- [Remnawave](https://remnawave.com) - VPN panel integration
- [shadcn/ui](https://ui.shadcn.com) - UI components
- [Fastify](https://fastify.io) - Web framework
- [Valkey](https://valkey.io) - Cache solution

---

**Thank you for using Rezeis!**