require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const stripe = require("stripe")(process.env.STRIPE_SCREAT_KEY);
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_SITE_URL],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

// Mongo URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.1djote4.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB connected");

    const db = client.db("garmentsDB");
    const productsCollection = db.collection("products");
    const ordersCollection = db.collection("orders");

    // save a plant in db

    app.post("/products", async (req, res) => {
      const productData = req.body;
      const result = await productsCollection.insertOne(productData);
      res.send(result);
    });

    app.get("/home-products", async (req, res) => {
      const products = await productsCollection
        .find({ showOnHome: true })
        .limit(6)
        .toArray();

      res.send(products);
    });
    // gel all products
    app.get("/products", async (req, res) => {
      const result = await productsCollection.find().toArray();
      res.send(result);
    });
    app.get("/products/:id", async (req, res) => {
      const id = req.params.id;
      const result = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // payment issue
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);
      // res.send(paymentInfo);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.buyer?.email,
        mode: "payment",
        metadata: {
          productId: paymentInfo?.productId,
          customer: paymentInfo?.buyer?.email,
        },
        success_url: `${process.env.CLIENT_SITE_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_SITE_URL}/product/${paymentInfo?.productId}`,
      });
      res.send({ url: session.url });
    });
    // payment issue

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(session);
      const product = await productsCollection.findOne({
        _id: new ObjectId(session.metadata.productId),
      });
      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });
      if (session.status === "complete" && product && !order) {
        const orderInfo = {
          productId: session.metadata.productId,
          transactionId: session.payment_intent,
          buyer: session.metadata.customer,
          status: "pending",
          manager: product.manager,
          name: product.name,
          category: product.category,
          quantity: 1,
          price: session.amount_total / 100,
        };
        // console.log(orderInfo);
        const result = await ordersCollection.insertOne(orderInfo);
        await productsCollection.updateOne(
          { _id: new ObjectId(session.metadata.productId) },
          { $inc: { quantity: -1 } }
        );
        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
      res.send({
        transactionId: session.payment_intent,
        orderId: order._id,
      });
    });
  } finally {
    // client.close();
  }
}

run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
  res.send("Garments Server Running");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
