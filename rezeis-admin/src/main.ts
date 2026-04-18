import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { appConfig } from './common/config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const appConfiguration: ConfigType<typeof appConfig> = app.get(appConfig.KEY);
  const port: number = appConfiguration.port;
  const nodeEnv: string = appConfiguration.nodeEnv;

  app.use(helmet());
  app.enableCors({
    origin: appConfiguration.corsOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();
  if (nodeEnv !== 'production') {
    const swaggerConfiguration = new DocumentBuilder()
      .setTitle('Rezeis Admin API')
      .setDescription('Internal API surface for Rezeis Admin')
      .setVersion('1.0.0')
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfiguration);
    SwaggerModule.setup('api/docs', app, swaggerDocument);
  }

  await app.listen(port);
}

void bootstrap();
