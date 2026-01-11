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
    origin: [process.env.CLIENT_SITE_URL, "http://localhost:5173"],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

// Mongo URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.1djote4.mongodb.net/?appName=Cluster0`;

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    console.log("✅ MongoDB connected");

    const db = client.db("garmentsDB");
    const productsCollection = db.collection("products");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");
    const managerRequestCollection = db.collection("managerRequest");

    // role-middleware

    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "admin only allow", role: user?.role });
      next();
    };
    const verifyMananger = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "manager")
        return res
          .status(403)
          .send({ message: "manager only allow", role: user?.role });
      next();
    };

    // save a product in db

    app.post("/products", verifyJWT, verifyMananger, async (req, res) => {
      const productData = req.body;
      const result = await productsCollection.insertOne(productData);
      res.send(result);
    });

    app.get("/home-products", async (req, res) => {
      const products = await productsCollection
        .find()
        .sort({ _id: -1 })
        .limit(6)
        .toArray();

      res.send(products);
    });

    ////////ADmin all-orders--------->
    app.get("/orders", verifyJWT, async (req, res) => {
      const orders = await ordersCollection.find().toArray();
      res.send(orders);
    });

    ////////ADmin all-orders--------->
    // get all products
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
          quantity: product.quantity,
          price: session.amount_total / 100,
          image: product?.image,
        };
        console.log(orderInfo);
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
    // get all orders for a buyer by email
    app.get("/my-orders", verifyJWT, async (req, res) => {
      const result = await ordersCollection
        .find({
          buyer: req.tokenEmail,
        })
        .toArray();
      res.send(result);
    });

    app.get("/manage-products", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;

      const query = { "manager.email": email };
      console.log(query);
      const result = await productsCollection.find(query).toArray();
      res.send(result);
    });
    app.delete("/products/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };
      const result = await productsCollection.deleteOne(query);
      res.send(result);
    });

    // Update order status
    app.patch("/orders/:id", verifyJWT, verifyMananger, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );
      res.send(result);
    });

    // Delete order
    app.delete("/orders/:id", verifyJWT, verifyMananger, async (req, res) => {
      const { id } = req.params;
      const result = await ordersCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // GET pending orders
    app.get("/orders/pending", verifyJWT, async (req, res) => {
      const query = { status: "pending" };
      const result = await ordersCollection.find(query).toArray();
      res.send(result);
    });
    // Approve order
    app.patch("/orders/approve/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;

      const updateDoc = {
        $set: {
          status: "Approved",
          approvedAt: new Date(),
        },
      };

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc
      );

      res.send(result);
    });
    // Reject order
    app.patch("/orders/reject/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;

      const updateDoc = {
        $set: {
          status: "Rejected",
        },
      };

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc
      );

      res.send(result);
    });
    app.get("/orders/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const order = await ordersCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(order);
    });

    // app.get("/my-inventory/:email", async (req, res) => {
    //   const email = req.params.email;
    //   const result = await productsCollection
    //     .find({
    //       "manager.email": email,
    //     })
    //     .toArray();
    //   res.send(result);
    // });

    // save & update all users in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "buyer";
      const query = { email: userData.email };
      const alreadyExist = await usersCollection.findOne(query);
      // console.log("user exist:", !!alreadyExist);

      if (alreadyExist) {
        // console.log("updateing user:");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }
      // console.log("saving new user info");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // get a users role

    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      // console.log(result);
      res.send({ role: result?.role });
    });

    // save to become manager request
    app.post("/become-manager", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const alreadyExist = await managerRequestCollection.findOne({ email });
      if (alreadyExist)
        return res.status(409).send({ message: "already requested" });
      const result = await managerRequestCollection.insertOne({ email });
      res.send(result);
    });
    // get manager reqst by admin
    app.get("/manager-request", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await managerRequestCollection.find().toArray();
      res.send(result);
    });
    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    app.patch("/update-role", verifyJWT, verifyAdmin, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );
      await managerRequestCollection.deleteOne({ email });
      res.send(result);
    });
    // pagination

    // get all products with pagination
    app.get("/products", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 6;
      const skip = (page - 1) * limit;

      const total = await productsCollection.countDocuments();
      const products = await productsCollection
        .find()
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({ total, products });
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
