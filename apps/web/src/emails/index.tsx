import { Button, Html, Text } from '@react-email/components';

export function VerifyEmail({ url }: { url: string }) {
  return (
    <Html>
      <Text>Confirm your email to finish signing up for HyperDash.</Text>
      <Button href={url}>Verify email</Button>
    </Html>
  );
}

export function ResetPasswordEmail({ url }: { url: string }) {
  return (
    <Html>
      <Text>Reset your HyperDash password.</Text>
      <Button href={url}>Reset password</Button>
    </Html>
  );
}
