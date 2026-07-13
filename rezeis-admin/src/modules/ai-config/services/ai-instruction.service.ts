import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface AiInstruction {
  id: string;
  title: string;
  slug: string;
  content: string;
  category: string;
  orderIndex: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface CreateAiInstructionInput {
  title: string;
  slug: string;
  content: string;
  category?: string;
  orderIndex?: number;
  /** Learned/imported entries are created as drafts (false) for operator review. */
  isActive?: boolean;
}

interface UpdateAiInstructionInput {
  title?: string;
  slug?: string;
  content?: string;
  category?: string;
  orderIndex?: number;
  isActive?: boolean;
}

@Injectable()
export class AiInstructionService implements OnModuleInit {
  private readonly logger = new Logger(AiInstructionService.name);

  public constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  private async seedIfEmpty(): Promise<void> {
    const count = await this.prisma.aiInstruction.count();
    if (count > 0) {
      this.logger.log('AiInstruction table already seeded, skipping');
      return;
    }

    this.logger.log('Seeding AiInstruction from knowledge/ directory...');

    const knowledgeDir = join(process.cwd(), 'knowledge');
    const seeds: CreateAiInstructionInput[] = [
      {
        title: 'Happ (iOS/Android)',
        slug: 'happ',
        category: 'app',
        content: this.readKnowledgeFile(join(knowledgeDir, 'apps/happ.md')),
        orderIndex: 1,
      },
      {
        title: 'INCY (iOS/Android/Windows)',
        slug: 'incy',
        category: 'app',
        content: this.readKnowledgeFile(join(knowledgeDir, 'apps/incy.md')),
        orderIndex: 2,
      },
      {
        title: 'FlclashX (macOS/iOS)',
        slug: 'flclashx',
        category: 'app',
        content: this.readKnowledgeFile(join(knowledgeDir, 'apps/flclashx.md')),
        orderIndex: 3,
      },
      {
        title: 'Подключение к VPN',
        slug: 'connection',
        category: 'vpn',
        content: this.readKnowledgeFile(join(knowledgeDir, 'vpn/connection.md')),
        orderIndex: 4,
      },
    ];

    for (const seed of seeds) {
      if (!seed.content) continue;
      try {
        await this.prisma.aiInstruction.create({ data: seed });
        this.logger.log(`Seeded: ${seed.title}`);
      } catch (error: unknown) {
        // Race-safe: the api and worker both run onModuleInit; a concurrent boot
        // may create the same unique slug first. Ignore the duplicate and any
        // per-seed failure so startup never crashes on seeding.
        const message = error instanceof Error ? error.message : 'unknown';
        this.logger.warn(`Skipped seeding "${seed.slug}": ${message}`);
      }
    }

    this.logger.log('AiInstruction seeding complete');
  }

  private readKnowledgeFile(path: string): string {
    if (!existsSync(path)) {
      this.logger.warn(`Knowledge file not found: ${path}`);
      return '';
    }
    return readFileSync(path, 'utf-8');
  }

  async listAll(): Promise<AiInstruction[]> {
    return this.prisma.aiInstruction.findMany({ orderBy: { orderIndex: 'asc' } });
  }

  async getPublicInstructions(): Promise<AiInstruction[]> {
    return this.prisma.aiInstruction.findMany({
      where: { isActive: true },
      orderBy: { orderIndex: 'asc' },
    });
  }

  async getById(id: string): Promise<AiInstruction> {
    const instruction = await this.prisma.aiInstruction.findUnique({ where: { id } });
    if (!instruction) {
      throw new NotFoundException(`AiInstruction with id ${id} not found`);
    }
    return instruction;
  }

  async create(input: CreateAiInstructionInput): Promise<AiInstruction> {
    return this.prisma.aiInstruction.create({ data: input });
  }

  async update(id: string, input: UpdateAiInstructionInput): Promise<AiInstruction> {
    await this.getById(id);
    return this.prisma.aiInstruction.update({ where: { id }, data: input });
  }

  async delete(id: string): Promise<void> {
    await this.getById(id);
    await this.prisma.aiInstruction.delete({ where: { id } });
  }
}
