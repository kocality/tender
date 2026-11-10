import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** QR of the plain deposit address (no payment URI). If rendering fails the address is still shown with a Copy button. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(text, { type: 'svg', margin: 1 }).then(
      (s) => alive && setSvg(s),
      () => alive && setSvg(null),
    );
    return () => {
      alive = false;
    };
  }, [text]);
  if (!svg) return null;
  // The markup is produced by the qrcode package from the address only.
  return <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
