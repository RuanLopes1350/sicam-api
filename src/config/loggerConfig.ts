import pino, { type LoggerOptions } from 'pino';
import { env } from './env.js';

// RNF-14: Logs estruturados em JSON com supressão estrita de segredos e tokens
export const loggerOptions: LoggerOptions = {
	level: env.LOG_LEVEL,
	redact: {
		paths: [
			'req.headers.authorization',
			'req.headers.cookie',
			'res.headers["set-cookie"]',
			'password',
			'*.password',
			'passwordHash',
			'*.passwordHash',
			'accessToken',
			'*.accessToken',
			'refreshToken',
			'*.refreshToken',
		],
		censor: '[REDACTED]',
	},
	...(env.NODE_ENV === 'development'
		? {
				transport: {
					target: 'pino-pretty',
					options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
				},
			}
		: {}),
};

export const logger = pino(loggerOptions);
