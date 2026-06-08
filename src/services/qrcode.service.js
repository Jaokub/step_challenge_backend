import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';

/**
 * @module QRCodeService
 * @description Service for generating QR codes and unique codes
 */

/**
 * Generate a QR code as a base64 data URL
 * @param {string} data - The data to encode in the QR code
 * @param {object} [options] - QR code generation options
 * @param {number} [options.width=300] - Width of the QR code image
 * @param {string} [options.color.dark='#000000'] - Dark module color
 * @param {string} [options.color.light='#ffffff'] - Light module color
 * @param {'L'|'M'|'Q'|'H'} [options.errorCorrectionLevel='M'] - Error correction level
 * @returns {Promise<string>} Base64 data URL of the QR code
 */
export async function generateQRCode(data, options = {}) {
  const defaultOptions = {
    width: 300,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
    ...options,
  };

  const dataURL = await QRCode.toDataURL(String(data), defaultOptions);
  return dataURL;
}

/**
 * Generate a unique short code using UUID (first 8 characters)
 * @returns {string} An 8-character unique code
 */
export function generateUniqueCode() {
  return uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
}

/**
 * Generate a QR code containing an activity identifier
 * @param {string} activityId - The activity ID to encode
 * @returns {Promise<string>} Base64 data URL of the QR code
 */
export async function generateActivityQR(activityId) {
  const payload = JSON.stringify({
    type: 'ACTIVITY_CHECKIN',
    activityId,
    generatedAt: new Date().toISOString(),
  });

  return generateQRCode(payload);
}

/**
 * Generate a QR code containing group invite data
 * @param {string} groupId - The group ID
 * @param {string} inviteCode - The group's unique invite code
 * @returns {Promise<string>} Base64 data URL of the QR code
 */
export async function generateGroupInviteQR(groupId, inviteCode) {
  const payload = JSON.stringify({
    type: 'GROUP_INVITE',
    groupId,
    inviteCode,
    generatedAt: new Date().toISOString(),
  });

  return generateQRCode(payload);
}
