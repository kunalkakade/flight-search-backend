require('dotenv').config(); 
const express = require("express");
const app = express();
const port = process.env.PORT || 3001;
const cors = require('cors');
const Amadeus = require('amadeus');
const NodeCache = require('node-cache');
const stripe = require("stripe")(process.env.STRIP_SECRET);
const SerpApi = require('google-search-results-nodejs');
const search = new SerpApi.GoogleSearch(process.env.SERPAPI_KEY);


// Enable CORS for all routes

const corsOptions = {
  origin: [
    'http://localhost:3002',
    'https://main.dcexb3b1fce9g.amplifyapp.com'
  ],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

app.use(express.json());

let amadeus;
try {
  if (!process.env.AMADEUS_API_KEY || !process.env.AMADEUS_API_SECRET) {
    throw new Error('Amadeus API credentials are missing in environment variables');
  }
  amadeus = new Amadeus({
    clientId: process.env.AMADEUS_API_KEY,
    clientSecret: process.env.AMADEUS_API_SECRET
  });
  console.log('Amadeus client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Amadeus client:', error.message);
  process.exit(1); // Exit the process if Amadeus client can't be initialized
}

const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour


app.get('/test', (req, res) => {
  console.log("test called")
  res.json({ 
    message: "Hello from the server!",
    timestamp: new Date().toISOString()
  });
});


app.post('/serp-flight-search', async (req, res) => {
  try {
    const { originCode, destinationCode, departureDate, returnDate, roundTrip } = req.body;

    if (!originCode || !destinationCode || !departureDate) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Create a cache key based on the search parameters
    let cacheKey;
    if (roundTrip) {
      cacheKey = `serp_flight_roundtrip_${originCode}_${destinationCode}_${departureDate}_${returnDate}`;
    } else {
      cacheKey = `serp_flight_oneway_${originCode}_${destinationCode}_${departureDate}`;
    }

    // Check if we have cached results
    let flightData = cache.get(cacheKey);
    
    if (flightData) {
      // If cached data exists, return it immediately
      return res.json({ data: flightData, fromCache: true });
    }

    // If not in cache, fetch from SerpApi
    const params = {
      engine: "google_flights",
      departure_id: originCode,
      arrival_id: destinationCode,
      outbound_date: departureDate,
      "currency":"AED",
      "show_hidden":true,
      ...(roundTrip && returnDate ? { return_date: returnDate } : {}),
      ...(roundTrip ? { type: 1 } : { type: 2 })
    };

    search.json(params, (data) => {
      if (data.error) {
        res.status(500).json({ error: data.error });
      } else {
        // Store the results in cache
        cache.set(cacheKey, data);
        res.json({ data: data, fromCache: false });
      }
    });
  } catch (error) {
    console.error('Error searching flights with SerpApi:', error);
    res.status(500).json({ error: 'An error occurred while searching for flights.' });
  }
});

app.post('/serp-return-flight-search', async (req, res) => {
  try {
    const { 
      originCode, 
      destinationCode, 
      departureDate, 
      returnDate, 
      departureToken 
    } = req.body;

    if (!originCode || !destinationCode || !departureDate || !returnDate || !departureToken) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Create a cache key based on the search parameters
    const cacheKey = `serp_return_flight_${originCode}_${destinationCode}_${departureDate}_${returnDate}_${departureToken}`;

    // Check if we have cached results
    let flightData = cache.get(cacheKey);
    
    if (flightData) {
      // If cached data exists, return it immediately
      return res.json({ data: flightData, fromCache: true });
    }

    // If not in cache, fetch from SerpApi
    const params = {
      engine: "google_flights",
      departure_id: originCode,
      arrival_id:  destinationCode,
      return_date: returnDate,
      outbound_date:departureDate,
      departure_token: departureToken,
      currency: "AED"
    };

    search.json(params, (data) => {
      if (data.error) {
        console.log("error:  ", data)
        res.status(500).json({ error: data.error });
      } else {
        // Store the results in cache
        cache.set(cacheKey, data);
        res.json({ data: data, fromCache: false });
      }
    });
  } catch (error) {
    console.error('Error searching return flights with SerpApi:', error);
    res.status(500).json({ error: 'An error occurred while searching for return flights.' });
  }
});


app.post('/search-flights', async (req, res) => {
  try {
    const { 
      originCode, 
      destinationCode, 
      departureDate, 
      adults,
      maxPrice,
      maxStops,
      airlines,
      returnDate,
      roundTrip
    } = req.body;

    // Create a cache key based on the search parameters
    const cacheKey = `${originCode}-${destinationCode}-${departureDate}${roundTrip ? `-${returnDate}` : ''}-AED`;

    // Check if we have cached results
    let flightData = cache.get(cacheKey);
    let fromCache = true;
    let flightDataLength = 0;

    if (!flightData) {
      // If not in cache, fetch from Amadeus API
      const searchParams = {
        originLocationCode: originCode,
        destinationLocationCode: destinationCode,
        departureDate: departureDate,
        adults: adults || '1',
        currencyCode: 'AED', // Request prices in AED
        max: 100 // Increased to allow for more filtering options
      };

      // Add returnDate for round-trip flights
      if (roundTrip && returnDate) {
        searchParams.returnDate = returnDate;
      }

      const response = await amadeus.shopping.flightOffersSearch.get(searchParams);

      flightData = response.data;
      flightDataLength = response.data.length;
      fromCache = false;

      // Store the results in cache
      cache.set(cacheKey, flightData);
    }

    // Apply filters
    let filteredFlights = flightData;

    if (maxPrice) {
      filteredFlights = filteredFlights.filter(flight => parseFloat(flight.price.total) <= parseFloat(maxPrice));
    }

    if (maxStops) {
      filteredFlights = filteredFlights.filter(flight => 
        flight.itineraries.every(itinerary => itinerary.segments.length - 1 <= parseInt(maxStops))
      );
    }

    if (airlines) {
      const airlineList = airlines.split(',');
      filteredFlights = filteredFlights.filter(flight => 
        flight.itineraries.every(itinerary =>
          itinerary.segments.some(segment => airlineList.includes(segment.carrierCode))
        )
      );
    }

    // Sort flights by price (ascending order)
    filteredFlights.sort((a, b) => parseFloat(a.price.total) - parseFloat(b.price.total));

    res.json({
      data: filteredFlights,
      fromCache,
      flightDataLength,
      roundTrip: !!roundTrip,
      currency: 'AED'
    });
  } catch (error) {
    console.error('Error searching flights:', error);
    res.status(500).json({ error: error.message || 'An error occurred while searching for flights.' });
  }
});


// New endpoint to clear cache (for admin use or scheduled tasks)
app.post('/clear-cache', (req, res) => {
  cache.flushAll();
  res.json({ message: 'Cache cleared successfully' });
});





app.get('/airports', async (req, res) => {
  try {
    const keyword = req.query.keyword || '';

    // If no keyword is provided, return an empty array or cached results
    if (!keyword) {
      const cachedAirports = cache.get('airports') || [];
      return res.json(cachedAirports);
    }

    // Check for cached results for this specific keyword
    const cacheKey = `airports_${keyword}`;
    const cachedResults = cache.get(cacheKey);
    if (cachedResults) {
      return res.json(cachedResults);
    }

    const response = await amadeus.referenceData.locations.get({
      subType: 'AIRPORT',
      keyword: keyword,
      sort: 'analytics.travelers.score',
      view: 'FULL'
    });

    const airports = response.data.map(airport => ({
      iataCode: airport.iataCode,
      name: airport.name,
      cityName: airport.address.cityName,
      countryName: airport.address.countryName
    }));

    // Cache the results for this keyword
    cache.set(cacheKey, airports);
    res.json(airports);
  } catch (error) {
    console.error('Error fetching airports:', error);
    res.status(500).json({ error: 'Failed to fetch airports' });
  }
});

// New endpoint to get airlines
app.get('/airlines', async (req, res) => {
  try {
    const cachedAirlines = cache.get('airlines');
    if (cachedAirlines) {
      return res.json(cachedAirlines);
    }

    const response = await amadeus.referenceData.airlines.get();

    const airlines = response.data.map(airline => ({
      iataCode: airline.iataCode,
      name: airline.businessName
    }));

    cache.set('airlines', airlines);
    res.json(airlines);
  } catch (error) {
    console.error('Error fetching airlines:', error);
    res.status(500).json({ error: 'Failed to fetch airlines' });
  }
});

app.get('/search-airports', async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || keyword.length < 2) {
      return res.status(400).json({ error: 'Keyword must be at least 2 characters long' });
    }

    const response = await amadeus.referenceData.locations.get({
      keyword,
      subType: Amadeus.location.AIRPORT,
      page: { limit: 10 }
    });

    const airports = response.data.map(airport => ({
      iataCode: airport.iataCode,
      name: airport.name,
      cityName: airport.address.cityName,
      countryName: airport.address.countryName
    }));

    res.json(airports);
  } catch (error) {
    console.error('Error searching airports:', error);
    res.status(500).json({ error: 'Failed to search airports', details: error.response?.body || error.message });
  }
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

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { flight, returnFlight } = req.body;

    // Function to format date
    const formatDate = (dateString) => {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    };

    // Function to get flight details based on source
    const getFlightDetails = (flightData, isReturn = false) => {
      if (flightData.source === 'amadeus') {
        const segment = isReturn ? flightData.segments[1][0] : flightData.segments[0][0];
        return {
          departure: segment.departure,
          arrival: segment.arrival,
          airline: segment.airlineName,
          flightNumber: segment.flightNumber,
          travelClass: flightData.travelClass
        };
      } else { // Assume SERP structure
        if (isReturn && returnFlight) {
          return {
            departure: {
              airport: returnFlight.flights[0].departure_airport.id,
              time: returnFlight.flights[0].departure_airport.time
            },
            arrival: {
              airport: returnFlight.flights[0].arrival_airport.id,
              time: returnFlight.flights[0].arrival_airport.time
            },
            airline: returnFlight.flights[0].airline,
            flightNumber: returnFlight.flights[0].flight_number,
            travelClass: returnFlight.flights[0].travel_class
          };
        } else {
          const segment = flightData.segments[0][0];
          return {
            departure: segment.departure,
            arrival: segment.arrival,
            airline: segment.airlineName,
            flightNumber: segment.flightNumber,
            travelClass: flightData.travelClass
          };
        }
      }
    };

    const outboundFlight = getFlightDetails(flight);
    const isRoundTrip = flight.source === 'amadeus' ? flight.segments.length > 1 : returnFlight !== null;
    const returnFlightDetails = isRoundTrip ? getFlightDetails(flight.source === 'amadeus' ? flight : returnFlight, true) : null;

    // Create product name
    let productName = `Flight: ${outboundFlight.departure.airport} to ${outboundFlight.arrival.airport}`;
    if (isRoundTrip) {
      productName += ` (Round Trip)`;
    }

    // Create product description
    let description = `Outbound: ${outboundFlight.departure.airport} to ${outboundFlight.arrival.airport} on ${formatDate(outboundFlight.departure.time)}`;
    if (isRoundTrip) {
      description += `\nReturn: ${returnFlightDetails.departure.airport} to ${returnFlightDetails.arrival.airport} on ${formatDate(returnFlightDetails.departure.time)}`;
    }

    // Add more details to the description
    description += `\nAirline: ${outboundFlight.airline}`;
    description += `\nFlight Number: ${outboundFlight.flightNumber}`;
    description += `\nClass: ${outboundFlight.travelClass}`;
    if (isRoundTrip) {
      description += `\nReturn Airline: ${returnFlightDetails.airline}`;
      description += `\nReturn Flight Number: ${returnFlightDetails.flightNumber}`;
      description += `\nReturn Class: ${returnFlightDetails.travelClass}`;
    }

    // Create a product for this flight
    const product = await stripe.products.create({
      name: productName,
      description: description,
    });

    // Calculate total price
    const totalPrice = isRoundTrip && flight.source !== 'amadeus'
      ? (flight.price + returnFlight.price) * 100 // Convert to cents
      : flight.price * 100;

    // Create a price for the product
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: totalPrice,
      currency: flight.currency,
    });

    // Prepare metadata
    const metadata = {
      flight_type: isRoundTrip ? 'round_trip' : 'one_way',
      outbound_from: outboundFlight.departure.airport,
      outbound_to: outboundFlight.arrival.airport,
      outbound_date: formatDate(outboundFlight.departure.time),
      outbound_airline: outboundFlight.airline,
      outbound_flight_number: outboundFlight.flightNumber,
      outbound_class: outboundFlight.travelClass,
      data_source: flight.source
    };

    if (isRoundTrip) {
      metadata.return_from = returnFlightDetails.departure.airport;
      metadata.return_to = returnFlightDetails.arrival.airport;
      metadata.return_date = formatDate(returnFlightDetails.departure.time);
      metadata.return_airline = returnFlightDetails.airline;
      metadata.return_flight_number = returnFlightDetails.flightNumber;
      metadata.return_class = returnFlightDetails.travelClass;
    }

    // Create a checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: price.id,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: metadata
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'An error occurred while creating the checkout session.' });
  }
});
app.get('/checkout-session', async (req, res) => {
  const { sessionId } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.json(session);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});