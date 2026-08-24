import { ethers } from 'ethers';
import { pool } from '../db.js';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export async function loadAllSettings(conn) {
  const [rows] = await conn.query('SELECT setting_key, setting_value FROM settings');
  const map = {};
  for (const row of rows) map[row.setting_key] = row.setting_value;
  return map;
}

export async function getBlockchainConfig(conn) {
  const s = await loadAllSettings(conn);
  return {
    platformMode: s.platform_mode || 'demo',
    bep20ContractAddress: s.bep20_contract_address || '',
    paymentTokenAddress: s.payment_token_address || '',
    paymentTokenSymbol: s.payment_token_symbol || 'BNB',
    chainId: parseInt(s.chain_id || '97'),
    chainName: s.chain_name || 'BSC Testnet',
    rpcUrl: s.rpc_url || '',
    blockExplorerUrl: s.block_explorer_url || 'https://testnet.bscscan.com',
    adminTreasuryWallet: s.admin_treasury_wallet || '',
    adminPayoutWallet: s.admin_payout_wallet || s.admin_treasury_wallet || '',
    tokenDecimals: parseInt(s.token_decimals || '18'),
    paymentDecimals: parseInt(s.payment_decimals || '18'),
    tokenPrice: parseFloat(s.token_price || '1'),
    tokenName: s.token_name || 'XIT Token',
    tokenSymbol: s.token_symbol || 'XIT',
    liquidityAmount: s.liquidity_amount || '0',
  };
}

export function isBlockchainMode(mode) {
  return mode === 'testnet' || mode === 'real';
}

function getProvider(rpcUrl) {
  if (!rpcUrl) throw new Error('RPC URL not configured');
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getWallet(privateKey, provider) {
  if (!privateKey) throw new Error('Admin private key not configured in server .env (ADMIN_PRIVATE_KEY)');
  return new ethers.Wallet(privateKey, provider);
}

export async function verifyBuyTransaction(conn, txHash, expectedPaymentAmount, fromAddress) {
  const config = await getBlockchainConfig(conn);

  if (!config.adminTreasuryWallet) {
    throw new Error('Admin treasury wallet not configured');
  }

  const provider = getProvider(config.rpcUrl);
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) throw new Error('Transaction not found or not confirmed yet');
  if (receipt.status !== 1) throw new Error('Transaction failed on chain');

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`Wrong chain. Expected ${config.chainId}, got ${network.chainId}`);
  }

  const [existing] = await conn.query('SELECT id FROM transactions WHERE tx_hash = ?', [txHash]);
  if (existing.length > 0) throw new Error('Transaction hash already used');

  const tx = await provider.getTransaction(txHash);
  if (!tx) throw new Error('Transaction details not found');

  const treasury = config.adminTreasuryWallet.toLowerCase();
  const expectedWei = ethers.parseUnits(expectedPaymentAmount.toFixed(8), config.paymentDecimals);

  if (!config.paymentTokenAddress) {
    if (tx.to?.toLowerCase() !== treasury) {
      throw new Error('Payment was not sent to admin treasury wallet');
    }
    if (tx.value < expectedWei) {
      throw new Error(`Insufficient payment. Expected ${expectedPaymentAmount}, received less`);
    }
    if (fromAddress && tx.from.toLowerCase() !== fromAddress.toLowerCase()) {
      throw new Error('Transaction sender does not match connected wallet');
    }
  } else {
    const iface = new ethers.Interface(ERC20_ABI);
    let found = false;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== config.paymentTokenAddress.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === 'Transfer') {
          const to = parsed.args.to.toLowerCase();
          const value = parsed.args.value;
          const from = parsed.args.from.toLowerCase();
          if (to === treasury && value >= expectedWei) {
            if (fromAddress && from !== fromAddress.toLowerCase()) {
              throw new Error('Transaction sender does not match connected wallet');
            }
            found = true;
            break;
          }
        }
      } catch {
        // skip unparseable logs
      }
    }

    if (!found) throw new Error('Valid payment token transfer to treasury not found');
  }

  return { chainId: config.chainId, config };
}

export async function sendTokenPayout(conn, toAddress, tokenAmount) {
  const config = await getBlockchainConfig(conn);
  const privateKey = process.env.ADMIN_PRIVATE_KEY;

  if (!config.bep20ContractAddress) {
    throw new Error('BEP-20 contract address not configured');
  }

  const provider = getProvider(config.rpcUrl);
  const wallet = getWallet(privateKey, provider);
  const contract = new ethers.Contract(config.bep20ContractAddress, ERC20_ABI, wallet);
  const amountWei = ethers.parseUnits(tokenAmount.toFixed(8), config.tokenDecimals);

  const tx = await contract.transfer(toAddress, amountWei);
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    chainId: config.chainId,
  };
}

/** Verify user sent XIT tokens back to admin pool on sell. */
export async function verifySellTokenTransfer(conn, txHash, expectedTokenAmount, fromAddress) {
  const config = await getBlockchainConfig(conn);

  if (!config.bep20ContractAddress) {
    throw new Error('BEP-20 contract address not configured');
  }

  const adminWallet = (config.adminPayoutWallet || config.adminTreasuryWallet || '').toLowerCase();
  if (!adminWallet) {
    throw new Error('Admin payout wallet not configured');
  }

  const provider = getProvider(config.rpcUrl);
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) throw new Error('Transaction not found or not confirmed yet');
  if (receipt.status !== 1) throw new Error('Transaction failed on chain');

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`Wrong chain. Expected ${config.chainId}, got ${network.chainId}`);
  }

  const [existing] = await conn.query('SELECT id FROM transactions WHERE tx_hash = ?', [txHash]);
  if (existing.length > 0) throw new Error('Transaction hash already used');

  const expectedWei = ethers.parseUnits(expectedTokenAmount.toFixed(8), config.tokenDecimals);
  const iface = new ethers.Interface(ERC20_ABI);
  let found = false;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.bep20ContractAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === 'Transfer') {
        const from = parsed.args.from.toLowerCase();
        const to = parsed.args.to.toLowerCase();
        const value = parsed.args.value;
        if (to === adminWallet && value >= expectedWei) {
          if (fromAddress && from !== fromAddress.toLowerCase()) {
            throw new Error('Transaction sender does not match connected wallet');
          }
          found = true;
          break;
        }
      }
    } catch (err) {
      if (err.message?.includes('connected wallet')) throw err;
    }
  }

  if (!found) {
    throw new Error('Valid XIT token transfer to admin wallet not found');
  }

  return { chainId: config.chainId, config };
}

/** Send BNB or payment token back to user after sell. */
export async function sendPaymentPayout(conn, toAddress, paymentAmount) {
  const config = await getBlockchainConfig(conn);
  const privateKey = process.env.ADMIN_PRIVATE_KEY;
  const provider = getProvider(config.rpcUrl);
  const wallet = getWallet(privateKey, provider);
  const amountWei = ethers.parseUnits(paymentAmount.toFixed(8), config.paymentDecimals);

  if (!config.paymentTokenAddress) {
    const balance = await provider.getBalance(wallet.address);
    if (balance < amountWei) {
      throw new Error('Treasury has insufficient BNB for sell payout');
    }
    const tx = await wallet.sendTransaction({ to: toAddress, value: amountWei });
    const receipt = await tx.wait();
    return { txHash: receipt.hash, chainId: config.chainId };
  }

  const contract = new ethers.Contract(config.paymentTokenAddress, ERC20_ABI, wallet);
  const tx = await contract.transfer(toAddress, amountWei);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, chainId: config.chainId };
}

export async function getTreasuryTokenBalance(conn) {
  const config = await getBlockchainConfig(conn);
  if (!config.bep20ContractAddress || !config.adminPayoutWallet) return null;

  try {
    const provider = getProvider(config.rpcUrl);
    const contract = new ethers.Contract(config.bep20ContractAddress, ERC20_ABI, provider);
    const balance = await contract.balanceOf(config.adminPayoutWallet);
    return ethers.formatUnits(balance, config.tokenDecimals);
  } catch {
    return null;
  }
}
