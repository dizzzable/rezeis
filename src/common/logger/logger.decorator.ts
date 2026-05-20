import { Inject } from '@nestjs/common';
import { LOGGER_TOKEN } from './logger.constants';

export const InjectLogger = () => Inject(LOGGER_TOKEN);
