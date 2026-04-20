// x402 Passthrough — proxies x402-protected APIs, paying with the vault PKP wallet.
//
// 1. Caller sends { targetUrl, method?, body?, headers? }
// 2. Flow fetches target URL -> gets 402 with PAYMENT-REQUIRED header
// 3. Flow decodes requirements, signs EIP-3009 TransferWithAuthorization with vault PKP
// 4. Flow re-sends request with PAYMENT-SIGNATURE header
// 5. Returns upstream response + _actualCost
//
// Uses ethers v5 (available in Lit TEE environment).
// No secrets required — pays with the vault PKP's USDC balance on Base.

const targetUrl = params.targetUrl;
if (!targetUrl) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing "targetUrl" parameter' }),
  });
  throw new Error('Missing targetUrl');
}

if (!params.pkpAddress) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'No vault PKP — flow needs a vault set up' }),
  });
  throw new Error('No vault PKP');
}

const method = (params.method || 'GET').toUpperCase();
const requestHeaders = params.headers || {};
if (params.body && !requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
  requestHeaders['Content-Type'] = 'application/json';
}

// Step 1: Make initial request to get 402 challenge
const initialRes = await fetch(targetUrl, {
  method,
  headers: requestHeaders,
  ...(params.body ? { body: JSON.stringify(params.body) } : {}),
});

// If the upstream doesn't return 402, just pass through the response
if (initialRes.status !== 402) {
  const responseBody = await initialRes.text();
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { parsed = responseBody; }
  Lit.Actions.setResponse({
    response: JSON.stringify({
      data: parsed,
      upstreamStatus: initialRes.status,
      _actualCost: 0,
    }),
  });
  // Return early — no need to throw, setResponse handles the output
} else {
  // Step 2: Decode PAYMENT-REQUIRED header
  const paymentRequiredHeader = initialRes.headers.get('payment-required') || initialRes.headers.get('PAYMENT-REQUIRED');
  if (!paymentRequiredHeader) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'Upstream returned 402 but no PAYMENT-REQUIRED header' }),
    });
    throw new Error('No PAYMENT-REQUIRED header');
  }

  // Decode base64 -> JSON
  const paymentRequired = JSON.parse(atob(paymentRequiredHeader));
  const accepts = paymentRequired.accepts;
  if (!accepts || accepts.length === 0) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'No accepted payment methods in PAYMENT-REQUIRED' }),
    });
    throw new Error('No accepts');
  }

  const requirements = accepts[0];
  const upstreamAmount = BigInt(requirements.amount);
  const payTo = requirements.payTo;
  const scheme = requirements.scheme || 'exact';

  // USDC on Base
  const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  // Step 3: Get vault PKP private key and sign EIP-3009 TransferWithAuthorization
  const privateKey = await Lit.Actions.getPrivateKey({ pkpId: params.pkpAddress });
  const wallet = new ethers.Wallet(privateKey);

  // Generate random nonce (bytes32)
  const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(32));

  // Valid from now, valid for 1 hour
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 3600;

  // EIP-712 domain for USDC on Base
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: USDC_ADDRESS,
  };

  // EIP-3009 TransferWithAuthorization types
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const message = {
    from: wallet.address,
    to: payTo,
    value: upstreamAmount.toString(),
    validAfter,
    validBefore,
    nonce,
  };

  // Sign EIP-712 typed data
  const signature = await wallet._signTypedData(domain, types, message);

  // Build the payment payload
  const paymentPayload = {
    x402Version: 2,
    scheme,
    network: requirements.network || 'base:8453',
    payload: {
      signature,
      authorization: {
        from: wallet.address,
        to: payTo,
        value: upstreamAmount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  // Encode as base64
  const paymentSignature = btoa(JSON.stringify(paymentPayload));

  // Step 4: Re-send request with payment
  const paidRes = await fetch(targetUrl, {
    method,
    headers: {
      ...requestHeaders,
      'Payment-Signature': paymentSignature,
      'X-Payment': paymentSignature,
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });

  const responseBody = await paidRes.text();
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { parsed = responseBody; }

  if (paidRes.status !== 200) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: `Upstream returned ${paidRes.status} after payment`,
        upstreamStatus: paidRes.status,
        body: typeof parsed === 'string' ? parsed.slice(0, 2000) : parsed,
        _actualCost: Number(upstreamAmount),
      }),
    });
    throw new Error(`Upstream error: ${paidRes.status}`);
  }

  // Step 5: Return upstream response + actual cost
  Lit.Actions.setResponse({
    response: JSON.stringify({
      data: parsed,
      upstreamStatus: paidRes.status,
      _actualCost: Number(upstreamAmount),
      paidTo: payTo,
      paidFrom: wallet.address,
    }),
  });
}
