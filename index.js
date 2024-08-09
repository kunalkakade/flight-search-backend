const express = require("express");
const app = express();
const port = process.env.PORT || 3001;
const cors = require('cors');
const stripe = require("stripe")("sk_test_51PlTskDI9pAomXvvgLmOKrdvkQUfzGBqbJf9uEjfXke5Zx8AhHy0CjCwNVap6ISguK4B8LPM2h900H8aiUSaJEVv00JDg0AE16");

// Enable CORS for all routes
app.use(cors({
  origin: 'http://localhost:3002' // Allow only your React app's origin
}));
app.use(express.json());

app.get('/test', (req, res) => {
  console.log("test called")
  res.json({ 
    message: "Hello from the server!",
    timestamp: new Date().toISOString()
  });
});


app.post("/create-payment-intent", async (req, res) => {
  console.log("create-payment-intent called")
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: req.body.amount,
      currency: "usd",
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/create-invoice-session', async (req, res) => {
  try {
    const { invoiceId } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      invoice: invoiceId,
      success_url: 'http://localhost:3001/success',
      cancel_url: 'http://localhost:3001/cancel',
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// New endpoint to retrieve an invoice
app.get('/invoice/:invoiceId', async (req, res) => {
  try {
    const invoice = await stripe.invoices.retrieve(req.params.invoiceId);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// This is your Stripe CLI webhook secret for testing your endpoint locally.
const endpointSecret = "whsec_e8a5d354a73018bb0b41c056228442dd7027964abce93305b18f37515c2109c4";

app.post('/webhook', express.raw({type: 'application/json'}), (request, response) => {
  
  console.log("webhook called")
  
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(JSON.stringify(request.body), sig, endpointSecret);
    console.log(`handled event type ${event.type}`);
  } catch (err) {
    console.log("error", err)
    response.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle the event
  console.log(`Unhandled event type ${event.type}`);

  // Return a 200 response to acknowledge receipt of the event
  response.send();
});


app.listen(port, () => {
  console.log("Server is listening on port 3001");
});
