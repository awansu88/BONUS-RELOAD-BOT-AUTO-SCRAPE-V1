import crypto from 'crypto';
import { RawTransaction } from '../../types/transaction';
import {
  normalizeUserName,
  normalizeAccountNumber,
  normalizeAmount,
  normalizeProcessDate
} from '../../utils/normalization';
import { getLogger } from './logger-service';

export class FingerprintGenerator {
  generate(transaction: RawTransaction): string {
    const normalizedUserName = normalizeUserName(transaction.userName);
    const normalizedAccountNumber = normalizeAccountNumber(transaction.accountNumber);
    const normalizedAmount = normalizeAmount(transaction.amount);
    const normalizedProcessDate = normalizeProcessDate(transaction.processDate);
    
    const input = [
      normalizedUserName,
      normalizedAccountNumber,
      String(normalizedAmount),
      normalizedProcessDate
    ].join('|');
    
    const fingerprint = crypto.createHash('sha1').update(input, 'utf8').digest('hex');
    getLogger().diag(`Fingerprint: ${fingerprint} from: ${input}`);
    
    return fingerprint;
  }
  
  getShortFingerprint(fullFingerprint: string): string {
    return fullFingerprint.substring(0, 8).toUpperCase();
  }
}
