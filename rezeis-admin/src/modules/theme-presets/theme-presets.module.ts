import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminThemePresetsController } from './controllers/admin-theme-presets.controller';
import { ThemePresetsService } from './services/theme-presets.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminThemePresetsController],
  providers: [ThemePresetsService],
  exports: [ThemePresetsService],
})
export class ThemePresetsModule {}
