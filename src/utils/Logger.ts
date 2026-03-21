/**
 * Centralized logging utility to avoid duplication.
 */

import {OutputChannel, window} from "vscode";

/**
 * Sanitize error messages to prevent leaking sensitive information
 * Redacts paths, credentials, and limits message length
 * @param error - The error to sanitize
 * @returns Sanitized error message safe for logging
 */
function sanitizeError(error: Error): string {
	let message = error.message || String(error);
	
	// Limit message length to prevent log flooding
	if (message.length > 500) {
		message = message.slice(0, 500) + '... [truncated]';
	}
	
	// Redact absolute file paths (Unix-style home paths)
	message = message.replace(/\/home\/[\w\-]+/g, '~');
	
	// Redact absolute file paths (Windows-style user paths)
	message = message.replace(/[A-Z]:\\Users\\[\w\-]+/g, '~');
	
	// Redact common credential patterns
	message = message.replace(/token['":\s=]+[^\s'"]+/gi, 'token="[REDACTED]"');
	message = message.replace(/password['":\s=]+[^\s'"]+/gi, 'password="[REDACTED]"');
	message = message.replace(/secret['":\s=]+[^\s'"]+/gi, 'secret="[REDACTED]"');
	message = message.replace(/api[_-]?key['":\s=]+[^\s'"]+/gi, 'api_key="[REDACTED]"');
	message = message.replace(/authorization['":\s=]+[^\s'"]+/gi, 'authorization="[REDACTED]"');
	
	// Redact OAuth tokens and JWT-like patterns
	message = message.replace(/bearer\s+[^\s]+/gi, 'bearer [REDACTED]');
	message = message.replace(/eyJ[A-Za-z0-9_-]+/g, '[JWT_REDACTED]');
	
	return message;
}

export class Logger {
    private outputChannel: OutputChannel;

    constructor(channelName: string = "Function Scanner") {
        this.outputChannel = window.createOutputChannel(channelName);
    }

    info(message: string): void {
        this.log(message, "INFO");
    }

    warn(message: string): void {
        this.log(message, "WARN");
    }

    error(message: string, error?: Error): void {
        const errorMsg = error ? `${message}: ${sanitizeError(error)}` : message;
        this.log(errorMsg, "ERROR");
    }

    debug(message: string): void {
        this.log(message, "DEBUG");
    }

    private log(message: string, level: string): void {
        const timestamp = new Date().toISOString();
        const formatted = `[${timestamp}] [${level}] ${message}`;
        this.outputChannel.appendLine(formatted);
    }

    show(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}
