const axios = require("axios");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const SOL_MINT = "So11111111111111111111111111111111111111112";

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDateTime(timestamp) {
  if (!timestamp) return "N/A";

  // If timestamp is in seconds, convert to milliseconds
  if (timestamp.toString().length <= 10) {
    timestamp *= 1000;
  }

  const date = new Date(timestamp);

  return date.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

async function getTokenBalances(walletAddress) {
  try {
    const response = await axios.get(
      `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${HELIUS_API_KEY}`
    );

    if (response.data && response.data.tokens) {
      const balances = new Map();
      response.data.tokens.forEach((token) => {
        balances.set(
          token.mint,
          parseFloat(token.amount) / 10 ** token.decimals
        );
      });

      return balances;
    }

    return new Map();
  } catch (error) {
    console.error("Error fetching token balances:", error.message);

    return new Map();
  }
}

async function getSolBalance(walletAddress) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${HELIUS_API_KEY}`;
    const response = await axios.get(url);
    if (response.data && response.data.nativeBalance) {
      const balance = response.data.nativeBalance / 1e9;

      return balance;
    }
  } catch (error) {
    console.error("Error fetching SOL balance:", error.message);

    return 0;
  }
}

async function getTokenName(mintAddress) {
  try {
    const response = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        jsonrpc: "2.0",
        id: "text",
        method: "getAsset",
        params: { id: mintAddress },
      }
    );

    if (response.data && response.data.result) {
      const metadata = response.data.result.content.metadata;
      const decodedSymbol = (metadata.symbol);

      return decodedSymbol || mintAddress;
    }


    return mintAddress;
  } catch (error) {
    console.error(
      `Error fetching token name for ${mintAddress}:`,
      error.message
    );

    return mintAddress;
  }
}

async function getTokenMintTimestamp(TOKEN_MINT) {
  try {
    const response = await axios.get(
      `https://api.helius.xyz/v0/addresses/${TOKEN_MINT}/transactions?api-key=${HELIUS_API_KEY}`
    );

    return response.data[response.data.length - 1].timestamp;
  } catch (error) {
    console.error("Error fetching token data:", error.message);
    console.error("Full error:", error.response?.data || error);
    throw error;
  }
}

class TokenAnalysis {
  constructor(tokenMint) {
    this.tokenMint = tokenMint;
    this.tokenName = "";
    this.splIn = 0;
    this.splOut = 0;
    this.buyAmount = 0;
    this.soldAmount = 0;
    this.buyFee = 0;
    this.sellFee = 0;
    this.firstBuyTip = 0;
    this.lastSellTip = 0;
    this.currentPosition = 0;
    this.buyTxSequence = 0;
    this.sellTxSequence = 0;
    this.firstBuyTime = null;
    this.lastSellTime = null;
    this.protocol = "Unknown";
    this.contract = tokenMint;
  }
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
    .toString()
    .padStart(2, "0")}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' })
  }

  try {

    const SNIPE_THRESHOLD = 180; // 3 minutes in seconds
    const RUG_LOSS_THRESHOLD = -90; // -90% loss threshold
    const { walletAddress } = req.body
    const WALLET_ADDRESS = walletAddress
    const now = new Date();

    const solBalance = await getSolBalance(WALLET_ADDRESS);

    const formattedDate = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');


    const trades = [];

    const buy_tips = []
    const sell_tips = []

    const overview = {
      // Performance Metrics
      roi: 0,
      pnl: 0,
      winRate: 0,
      balance: 0,
      grossProfit: 0,
      netProfit: 0,
      invested: 0,
      returned: 0,

      // Transaction Metrics
      buyFees: 0,
      sellFees: 0,
      totalFees: 0,
      buyTx: 0,
      sellTx: 0,
      totalTokens: 0,

      // Trading Metrics
      tradingPeriod: 0,
      avgDuration: "00:00:00",
      snipes: 0,
      avgGasFees: 0,
      medianFirstBuyTip: 0,
      medianSellTip: 0,
      scamsRugs: 0,

      winningTrades: 0,
      losingTrades: 0,
      avgInvested: 0
    }

    let sumOfTradingTime = 0
    let numOfCanCalculateTradingTime = 0

    let allTransactions = [];
    let beforeSignature = null;
    let tokenAnalytics = new Map();
    const currentBalances = await getTokenBalances(WALLET_ADDRESS);
    console.log("Fetched current token balances");
    for (let i = 0; i < 10; i++) {
      try {
        const response = await axios.get(
          `https://api.helius.xyz/v0/addresses/${WALLET_ADDRESS}/transactions?api-key=${HELIUS_API_KEY}`,
          {
            params: {
              limit: 100,
              before: beforeSignature,
              type: "SWAP",
            },
          }
        );

        const transactions = response.data;

        if (transactions.length === 0) {
          break;
        }

        allTransactions = [...allTransactions, ...transactions];

        beforeSignature = transactions[transactions.length - 1].signature;

        console.log(
          `Fetched batch ${i + 1}: ${transactions.length} trade transactions`
        );
        await sleep(1000);
      } catch (requestError) {
        if (requestError.response?.status === 429) {
          console.log("Rate limit hit, waiting for 5 seconds...");
          await sleep(5000);
          i--;
          continue;
        }
        throw requestError;
      }
    }

    console.log(`Total transactions fetched: ${allTransactions.length}`);

    const latestTx = allTransactions[0];
    const oldestTx = allTransactions[allTransactions.length - 1];

    const periodInSeconds = latestTx.timestamp - oldestTx.timestamp;
    const periodInDays = periodInSeconds / (24 * 60 * 60);

    overview.tradingPeriod = Math.round(periodInDays * 100) / 100;

    const uniqueMints = new Set();
    allTransactions.forEach((tx) => {
      if (tx.tokenTransfers) {
        tx.tokenTransfers.forEach((transfer) => {
          if (transfer.mint !== SOL_MINT) {
            uniqueMints.add(transfer.mint);
          }
        });
      }
    });

    for (const mint of uniqueMints) {
      const tokenName = await getTokenName(mint);
      const analysis = new TokenAnalysis(mint);
      analysis.tokenName = tokenName;
      analysis.currentPosition = currentBalances.get(mint) || 0;
      tokenAnalytics.set(mint, analysis);
    }

    allTransactions.forEach(async (tx) => {
      if (tx.type === "SWAP" && tx.tokenTransfers) {
        const solTransfer = tx.tokenTransfers.find((t) => t.mint === SOL_MINT);
        if (!solTransfer) return;

        const tokenTransfer = tx.tokenTransfers.find(
          (t) => t.mint !== SOL_MINT
        );
        if (!tokenTransfer) return;

        const analysis = tokenAnalytics.get(tokenTransfer.mint);
        if (!analysis) return;

        const isBuy = solTransfer.fromUserAccount === WALLET_ADDRESS;
        analysis.protocol = tx.source || "Unknown";

        if (isBuy) {
          analysis.splIn += parseFloat(tokenTransfer.tokenAmount);
          analysis.buyAmount += parseFloat(solTransfer.tokenAmount);
          analysis.buyFee += parseFloat(tx.fee) / 1e9;
          analysis.buyTxSequence++;

          const jitoTip = tx.nativeTransfers?.find((transfer) =>
            JITO_TIP_ACCOUNTS.includes(transfer.toUserAccount)
          );

          if (!analysis.firstBuyTime || tx.timestamp < analysis.firstBuyTime) {
            analysis.firstBuyTime = tx.timestamp;
            if (analysis.firstBuyTime - getTokenMintTimestamp(tx.mint) <= SNIPE_THRESHOLD) {
              overview.snipes++
            }
            analysis.firstBuyTip = jitoTip
              ? parseFloat(jitoTip.amount) / 1e9
              : 0;
            buy_tips.push(analysis.firstBuyTip)
          }
        } else {
          analysis.splOut += parseFloat(tokenTransfer.tokenAmount);
          analysis.soldAmount += parseFloat(solTransfer.tokenAmount);
          analysis.sellFee += parseFloat(tx.fee) / 1e9;
          analysis.sellTxSequence++;

          const jitoTip = tx.nativeTransfers?.find((transfer) =>
            JITO_TIP_ACCOUNTS.includes(transfer.toUserAccount)
          );

          if (!analysis.lastSellTime || tx.timestamp > analysis.lastSellTime) {
            analysis.lastSellTime = tx.timestamp;
            analysis.lastSellTip = jitoTip
              ? parseFloat(jitoTip.amount) / 1e9
              : 0;
            sell_tips.push(analysis.lastSellTip)
          }
        }
      }
    });



    tokenAnalytics.forEach((analysis) => {
      if (analysis.buyAmount !== 0 || analysis.soldAmount !== 0) {
        let grossProfit = 0;
        let netProfit = 0;
        let profitPercent = 0;

        if (analysis.buyAmount !== 0 && analysis.soldAmount !== 0) {
          grossProfit = analysis.soldAmount - analysis.buyAmount;
          netProfit = grossProfit - analysis.buyFee - analysis.sellFee;
          profitPercent = (netProfit / analysis.buyAmount) * 100;
          if (profitPercent <= RUG_LOSS_THRESHOLD) {
            overview.scamsRugs++
          }

          sumOfTradingTime += (analysis.lastSellTime - analysis.firstBuyTime)
          numOfCanCalculateTradingTime++
        }

        const firstBuyTime = analysis.firstBuyTime
          ? new Date(analysis.firstBuyTime * 1000).toLocaleString()
          : "N/A";

        const lastSellTime = analysis.lastSellTime
          ? new Date(analysis.lastSellTime * 1000).toLocaleString()
          : "N/A";

        const tradeDuration =
          analysis.firstBuyTime && analysis.lastSellTime
            ? formatDuration(analysis.lastSellTime - analysis.firstBuyTime)
            : "N/A";



        const trade = {
          tokenName: analysis.tokenName,
          splIn: analysis.splIn,
          splOut: analysis.splOut,
          buyAmount: analysis.buyAmount,
          soldAmount: analysis.soldAmount,
          buyFee: analysis.buyFee,
          firstBuyTip: analysis.firstBuyTip,
          sellFee: analysis.sellFee,
          lastSellTip: analysis.lastSellTip,
          currentPosition: analysis.currentPosition,
          grossProfit: grossProfit,
          netProfit: netProfit,
          profit: profitPercent,
          buyTx: analysis.buyTxSequence,
          sellTx: analysis.sellTxSequence,
          firstBuy: formatDateTime(firstBuyTime),
          lastSell: formatDateTime(lastSellTime),
          duration: tradeDuration,
          contract: analysis.contract,
          protocol: analysis.protocol,
        };

        trades.push(trade);

        // Update overview stats
        overview.buyFees += analysis.buyFee;
        overview.sellFees += analysis.sellFee;
        overview.totalFees += analysis.buyFee + analysis.sellFee;
        overview.buyTx += analysis.buyTxSequence;
        overview.sellTx += analysis.sellTxSequence;
        overview.totalTokens++;
        overview.grossProfit += grossProfit;
        overview.netProfit += netProfit;
        overview.invested += analysis.buyAmount;
        overview.returned += analysis.soldAmount;
        if (profitPercent >= 0) {
          overview.winningTrades++;
        }
        else {
          overview.losingTrades++;
        }
      }
    });

    // Update overview stats
    overview.avgInvested = overview.invested / overview.totalTokens;
    overview.avgGasFees = overview.totalFees / overview.totalTokens;
    overview.winRate = (overview.winningTrades / trades.length) * 100;
    overview.balance = solBalance;
    overview.avgDuration = formatDuration(Math.round(sumOfTradingTime / numOfCanCalculateTradingTime))

    buy_tips.sort((a, b) => a - b);

    let median_buy_tips = (buy_tips.length % 2 !== 0)
      ? buy_tips[Math.floor(buy_tips.length / 2)]
      : (buy_tips[buy_tips.length / 2 - 1] + buy_tips[buy_tips.length / 2]) / 2;

    sell_tips.sort((a, b) => a - b);

    let median_sell_tips = (sell_tips.length % 2 !== 0)
      ? sell_tips[Math.floor(sell_tips.length / 2)]
      : (sell_tips[sell_tips.length / 2 - 1] + sell_tips[sell_tips.length / 2]) / 2;

    overview.medianFirstBuyTip = median_buy_tips
    overview.medianSellTip = median_sell_tips
    overview.roi = (overview.netProfit / overview.invested) * 100
    overview.pnl = overview.netProfit


    const walletData = {
      overview: overview,
      trades: trades,
      reportDate: formattedDate,
      wallet: walletAddress
    }

    res.status(200).json(walletData)
  } catch (error) {
    console.error('Wallet analysis error:', error)
    res.status(500).json({ message: 'Failed to analyze wallet' })
  }
}
