import { pool } from '../config/database';
import { TransactionModel } from '../models/transaction';
import { UserModel } from '../models/users';
import { EmailService } from '../services/email';
import { InvoiceService } from '../services/invoiceService';
import { InvoiceModel, InvoiceStatus } from '../models/invoice';
import logger from '../utils/logger';

export async function runMonthlyInvoiceJob() {
  const transactionModel = new TransactionModel();
  const userModel = new UserModel();
  const emailService = new EmailService();
  const invoiceService = new InvoiceService();
  const invoiceModel = new InvoiceModel();

  // Determine previous month
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  logger.info(`Starting monthly invoice job for ${month}/${year}`);

  let processedCount = 0;
  let successCount = 0;
  let failureCount = 0;

  try {
    // 1. Fetch "Business Clients" (kyc_level = 'full' and email NOT NULL)
    const businessUsersResult = await pool.query(`
      SELECT id FROM users 
      WHERE kyc_level = 'full' 
      AND email IS NOT NULL 
      AND status = 'active'
    `);

    const userIds = businessUsersResult.rows.map(r => r.id);
    logger.info(`Found ${userIds.length} potential business clients`);

    for (const userId of userIds) {
      try {
        processedCount++;

        const user = await userModel.findById(userId);
        if (!user || !user.email) {
          logger.debug(`Skipping user ${userId}: missing user or email`);
          continue;
        }

        // Check if invoice already exists for this period
        const existingInvoice = await invoiceModel.findByUserAndPeriod(userId, month, year);
        if (existingInvoice) {
          logger.debug(`Invoice already exists for user ${userId} in ${month}/${year}`);
          continue;
        }

        // 2. Fetch completed transactions for the previous month
        const transactions = await transactionModel.findCompletedByUserSince(userId, startDate);
        const monthTransactions = transactions.filter(tx => tx.createdAt <= endDate);

        if (monthTransactions.length === 0) {
          logger.info(`No transactions for user ${userId} in ${month}/${year}, skipping invoice.`);
          continue;
        }

        // 3. Generate and store invoice
        const invoice = await invoiceService.generateAndStoreInvoice(
          user,
          month,
          year,
          monthTransactions
        );

        // 4. Send Email
        try {
          await emailService.sendEmail({
            to: user.email,
            templateId: process.env.SENDGRID_INVOICE_TEMPLATE_ID || 'd-generic-invoice-template',
            dynamicTemplateData: {
              month: new Date(year, month - 1).toLocaleString('default', { month: 'long' }),
              year: year,
              name: user.phoneNumber || 'User',
              invoiceNumber: invoice.invoiceNumber,
            },
          });

          // Mark invoice as sent
          await invoiceService.markInvoiceAsSent(
            invoice.id,
            `sent-${Date.now()}`
          );

          logger.info(
            { invoiceId: invoice.id, userId: user.id },
            `Invoice sent to ${user.email}`
          );
          successCount++;
        } catch (emailErr) {
          await invoiceService.markInvoiceAsFailed(
            invoice.id,
            String(emailErr instanceof Error ? emailErr.message : emailErr)
          );
          logger.warn(
            { error: emailErr, invoiceId: invoice.id },
            `Failed to send invoice email to ${user.email}`
          );
          failureCount++;
        }
      } catch (err) {
        logger.error({ error: err, userId }, `Failed to process invoice for user ${userId}`);
        failureCount++;
      }
    }

    logger.info(
      { processed: processedCount, success: successCount, failed: failureCount },
      'Monthly invoice job completed'
    );
  } catch (err) {
    logger.error({ error: err }, 'Monthly invoice job failed');
    throw err;
  }
}
