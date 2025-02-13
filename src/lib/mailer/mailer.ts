import { Injectable } from "@nestjs/common";
import { getLogger } from "@/lib/logger";

export interface MailInput {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transport-agnostic mailer. The console transport is used in development
 * and tests; production deployments provide an SMTP/API-backed implementation
 * via the same interface (see docs/TODO: SMTP transport).
 */
export interface Mailer {
  send(input: MailInput): Promise<void>;
}

@Injectable()
export class ConsoleMailer implements Mailer {
  private readonly logger = getLogger();

  async send(input: MailInput): Promise<void> {
    this.logger.info(
      { to: input.to, subject: input.subject },
      "email dispatched (console transport)",
    );
  }
}
