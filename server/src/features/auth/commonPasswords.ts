/**
 * A small bundled list of very common passwords and base words (lowercase). The policy rejects a
 * password that equals one of these, or that is one of these followed only by digits/symbols.
 * Deliberately small: this is a guard against the worst choices, not a full breach corpus.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  // Base words (rejected with any trailing digits/symbols, e.g. "password2024!!!")
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'pass', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl',
  'zxcvbn', 'zxcvbnm', 'azerty', 'letmein', 'welcome', 'admin', 'administrator', 'root', 'toor',
  'login', 'master', 'monkey', 'dragon', 'football', 'baseball', 'basketball', 'soccer', 'hockey',
  'iloveyou', 'trustno1', 'sunshine', 'princess', 'shadow', 'superman', 'batman', 'starwars',
  'whatever', 'freedom', 'michael', 'jennifer', 'jordan', 'hunter', 'ranger', 'buster', 'thomas',
  'robert', 'charlie', 'daniel', 'andrew', 'joshua', 'george', 'computer', 'internet', 'secret',
  'changeme', 'default', 'guest', 'test', 'tester', 'testing', 'user', 'summer', 'winter', 'spring',
  'autumn', 'monday', 'friday', 'flower', 'cookie', 'cheese', 'chocolate', 'pepper', 'ginger',
  'killer', 'pokemon', 'naruto', 'minecraft', 'fortnite', 'samsung', 'google', 'apple', 'microsoft',
  'facebook', 'twitter', 'linkedin', 'yahoo', 'hello', 'helloworld', 'abc', 'abcd', 'abcdef',
  'abcdefg', 'abcdefgh', 'abcdefghijkl', 'access', 'mustang', 'harley', 'corvette', 'ferrari',
  'porsche', 'mercedes', 'tigger', 'pussy', 'lovely', 'loveme', 'love', 'lover', 'angel', 'baby',
  'matrix', 'merlin', 'qazwsx', 'qazwsxedc', '1qaz2wsx', '1qaz2wsx3edc', 'zaq12wsx', 'q1w2e3r4',
  'q1w2e3r4t5', 'q1w2e3r4t5y6', '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r5t6y', 'keyvault', 'vault',
  'secure', 'security', 'company', 'office', 'server', 'database', 'system', 'manager', 'service',
  'support', 'qwer', 'asdf', 'zxcv', 'iloveu', 'blink182', 'liverpool', 'chelsea', 'arsenal',
  'barcelona', 'realmadrid', 'jesus', 'christ', 'blessed', 'heaven', 'family', 'forever',
  'beautiful', 'butterfly', 'rainbow', 'purple', 'orange', 'banana', 'yellow', 'silver', 'golden',
  'diamond', 'success', 'passport', 'superstar', 'rockstar', 'nothing', 'anything', 'everything',
  // Full common passwords of 12+ characters
  '123456789012', '1234567890123', '12345678901234', '111111111111', '000000000000',
  '123123123123', '121212121212', '123321123321', '0987654321', '098765432112',
  'password1234', 'password12345', 'password123456', 'passwordpassword', 'qwerty123456',
  'qwertyuiop123', 'qwertyuiopasdf', 'iloveyou1234', 'letmein12345', 'welcome12345',
  'administrator1', 'changeme1234', 'trustno11234', 'sunshine1234', 'princess1234',
  'football1234', 'baseball1234', 'superman1234', 'monkey123456', 'dragon123456',
  'abc123456789', 'abcd12345678', 'aa1234567890', 'qwe123456789', 'asd123456789',
  'zxc123456789', 'qazwsxedcrfv', 'qwertyqwerty', 'asdfasdfasdf', 'asdfghjkl123',
  'zxcvbnm12345', 'iloveyouiloveyou', 'correcthorsebatterystaple', 'mypassword123',
  'thisismypassword', 'letmeinletmein', 'masterpassword', 'secretpassword',
]);
